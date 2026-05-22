'use strict';

// =============================================================================
// ThroughputManager — Rate-limited SMS sender with SMSC error handling
//
// Sends messages at a controlled rate, handles ESME_RTHROTTLED by re-queuing,
// auto-pauses after 10 consecutive throttles, and emits events for all SMSC
// errors so they can be displayed in the Event Log panel.
//
// Emits:
//   job_started({ jobId, totalCount, rate })
//   progress({ jobId, sent, failed, total, percentage, currentRate, targetRate, eta })
//   smsc_error({ jobId, destination, errorCode, errorName, errorMessage, isThrottle })
//   job_paused({ jobId, reason })
//   job_resumed({ jobId, rate })
//   job_completed({ jobId, sent, failed, total, duration, throttleCount })
//   job_stopped({ jobId, sent, failed })
// =============================================================================

const EventEmitter = require('events');

// ── SMPP Error Codes ────────────────────────────────────────────────────────

const SMPP_ERRORS = {
  0x00000000: { name: 'ESME_ROK',          description: 'Success',                                    isThrottle: false },
  0x00000003: { name: 'ESME_RINVCMDID',    description: 'Command not supported by SMSC',             isThrottle: false },
  0x0000000a: { name: 'ESME_RINVSRCADR',   description: 'Invalid source address format',             isThrottle: false },
  0x0000000b: { name: 'ESME_RINVDSTADR',   description: 'Invalid destination address',               isThrottle: false },
  0x0000000c: { name: 'ESME_RINVMSGID',    description: 'Invalid message ID',                        isThrottle: false },
  0x0000000d: { name: 'ESME_RBINDFAIL',    description: 'Authentication failed',                     isThrottle: false },
  0x0000000e: { name: 'ESME_RINVPASWD',    description: 'Invalid password',                          isThrottle: false },
  0x0000000f: { name: 'ESME_RINVSYSID',    description: 'Invalid system ID',                         isThrottle: false },
  0x00000014: { name: 'ESME_RMSGQFUL',     description: 'Message queue full',                        isThrottle: false },
  0x00000045: { name: 'ESME_RSUBMITFAIL',  description: 'Submit failed — check source/destination',  isThrottle: false },
  0x00000058: { name: 'ESME_RTHROTTLED',   description: 'Sending too fast — rate limit exceeded',    isThrottle: true  },
  0x00000061: { name: 'ESME_RINVSCHED',    description: 'Invalid schedule time',                    isThrottle: false },
  0x00000062: { name: 'ESME_RINVEXPIRY',   description: 'Message expired or already delivered',      isThrottle: false },
  0x00000063: { name: 'ESME_RINVDFTMSGID', description: 'Invalid default message ID',                isThrottle: false },
};

// Vendor-specific codes
const VENDOR_CODES = {
  104: 'ESME_RSUBMITFAIL (104/0x68) — General submit failure',
  118: 'ESME_RINVCODING (118/0x76) — Inconsistent data_coding across concatenated segments',
};

// ── ThroughputManager ──────────────────────────────────────────────────────

class ThroughputManager extends EventEmitter {

  constructor() {
    super();
    this.activeJobs = new Map();
    this.nextJobId = 1;
  }

  // ── Error Parsing ──────────────────────────────────────────────────────────

  parseSMPPError(error) {
    let errorCode = null;

    if (typeof error === 'number') {
      errorCode = error;
    } else if (error && error.command_status !== undefined) {
      errorCode = Number(error.command_status);
    } else if (error && error.code) {
      errorCode = Number(error.code);
    } else if (error && error.message) {
      const hexMatch = String(error.message).match(/0x[0-9A-Fa-f]{8}/);
      if (hexMatch) errorCode = parseInt(hexMatch[0], 16);

      if (!errorCode) {
        const numMatch = String(error.message).match(/Submit error (\d+)/);
        if (numMatch) errorCode = parseInt(numMatch[1], 10);
      }
    }

    let info = SMPP_ERRORS[errorCode];

    if (!info && errorCode !== null) {
      const vendorMsg = VENDOR_CODES[errorCode];
      if (vendorMsg) {
        info = {
          name: vendorMsg.split(' — ')[0] || `ESME_VENDOR_${errorCode}`,
          description: vendorMsg,
          isThrottle: false,
        };
      } else {
        info = {
          name: `ESME_VENDOR_${errorCode}`,
          description: error?.message || `Unknown SMSC error (${errorCode})`,
          isThrottle: false,
        };
      }
    }

    if (!info) {
      info = {
        name: 'Unknown Error',
        description: error?.message || String(error),
        isThrottle: false,
      };
    }

    return {
      code: errorCode !== null ? `0x${errorCode.toString(16).padStart(8, '0')}` : null,
      name: info.name,
      message: info.description,
      isThrottle: info.isThrottle,
    };
  }

  // ── Job Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Create a new throughput job.
   *
   * @param {object}   options
   * @param {string[]} options.destinations   Array of destination MSISDNs
   * @param {string}   options.message        SMS message content
   * @param {number}   options.ratePerSecond  Target rate (1-1000 msg/s)
   * @param {object}   [options.overrides={}] SMPP parameter overrides
   * @param {Function} options.sendCallback   async (dest, msg, overrides) => { success, messageId, error? }
   * @returns {string} jobId
   */
  createJob(options) {
    const {
      destinations,
      message,
      ratePerSecond,
      totalCount,
      overrides = {},
      sendCallback,
    } = options;

    if (!Array.isArray(destinations) || destinations.length === 0) {
      throw new Error('Throughput job requires a non-empty destinations array');
    }
    if (!message || !message.trim()) {
      throw new Error('Throughput job requires a message');
    }
    if (typeof sendCallback !== 'function') {
      throw new Error('Throughput job requires a sendCallback function');
    }

    const jobId = (this.nextJobId++).toString();

    // Expand destinations cyclically to reach totalCount
    const desiredTotal = (totalCount !== undefined && totalCount > 0) ? totalCount : destinations.length;
    const targets = [];
    for (let i = 0; i < desiredTotal; i++) {
      targets.push(destinations[i % destinations.length]);
    }

    const CONSECUTIVE_THROTTLE_LIMIT = 10;

    const job = {
      id: jobId,
      targets,
      message,
      ratePerSecond: Math.min(Math.max(ratePerSecond, 1), 1000),
      totalCount: targets.length,
      overrides,
      sendCallback,

      status: 'idle',              // idle | running | paused | stopped | completed
      sent: 0,
      failed: 0,
      consecutiveThrottles: 0,     // Consecutive throttle count (resets on success)
      throttleCount: 0,            // Total throttles
      results: [],
      currentIndex: 0,
      timeoutId: null,
      startTime: null,
      lastRateCheck: null,
      lastSentCount: 0,
      currentRate: 0,
    };

    this.activeJobs.set(jobId, job);
    return jobId;
  }

  /**
   * Start (or resume) a throughput job.
   * @param {string} jobId
   * @returns {boolean}
   */
  startJob(jobId) {
    const job = this.activeJobs.get(jobId);
    if (!job) return false;
    if (job.status === 'running' || job.status === 'completed') return false;

    job.status = 'running';
    if (!job.startTime) job.startTime = Date.now();
    job.lastRateCheck = Date.now();
    job.lastSentCount = job.sent;

    // Recursive setTimeout — runs processNext, then schedules the next tick
    const scheduleNext = () => {
      if (job.status !== 'running') return;
      const intervalMs = Math.max(1, Math.floor(1000 / job.ratePerSecond));
      job.timeoutId = setTimeout(async () => {
        await this._processNext(job);
        scheduleNext();
      }, intervalMs);
    };

    scheduleNext();

    this.emit('job_started', {
      jobId,
      totalCount: job.totalCount,
      rate: job.ratePerSecond,
    });

    return true;
  }

  /**
   * Pause a running job.
   * @param {string} jobId
   * @param {string} [reason='user']
   * @returns {boolean}
   */
  pauseJob(jobId, reason = 'user') {
    const job = this.activeJobs.get(jobId);
    if (!job || job.status !== 'running') return false;

    job.status = 'paused';
    if (job.timeoutId) {
      clearTimeout(job.timeoutId);
      job.timeoutId = null;
    }

    this.emit('job_paused', { jobId, reason });
    return true;
  }

  /**
   * Resume a paused job.
   * @param {string} jobId
   * @returns {boolean}
   */
  resumeJob(jobId) {
    const job = this.activeJobs.get(jobId);
    if (!job || job.status !== 'paused') return false;

    // Reset rate back to original and clear throttle state on manual resume
    job.consecutiveThrottles = 0;
    job.throttleCount = 0;

    this.emit('job_resumed', { jobId, rate: job.ratePerSecond });
    return this.startJob(jobId);
  }

  /**
   * Stop a job immediately.
   * @param {string} jobId
   * @returns {boolean}
   */
  stopJob(jobId) {
    const job = this.activeJobs.get(jobId);
    if (!job) return false;
    if (job.status === 'stopped' || job.status === 'completed') return false;

    job.status = 'stopped';
    if (job.timeoutId) {
      clearTimeout(job.timeoutId);
      job.timeoutId = null;
    }

    this.emit('job_stopped', { jobId, sent: job.sent, failed: job.failed });
    return true;
  }

  /**
   * Update the target rate for a running job.
   * @param {string} jobId
   * @param {number} newRate
   * @returns {boolean}
   */
  updateJobRate(jobId, newRate) {
    const job = this.activeJobs.get(jobId);
    if (!job) return false;

    const oldRate = job.ratePerSecond;
    job.ratePerSecond = Math.min(Math.max(newRate, 1), 1000);

    this.emit('rate_updated', { jobId, oldRate, newRate: job.ratePerSecond, autoReduced: false });
    return true;
  }

  /**
   * Get a summary of the job's current status.
   * @param {string} jobId
   * @returns {object|null}
   */
  getJobStatus(jobId) {
    const job = this.activeJobs.get(jobId);
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      sent: job.sent,
      failed: job.failed,
      total: job.totalCount,
      currentRate: job.currentRate,
      targetRate: job.ratePerSecond,
      throttleCount: job.throttleCount,
    };
  }

  // ── Internal Processing ───────────────────────────────────────────────────

  /**
   * Process the next message in the queue.
   * @param {object} job
   * @private
   */
  async _processNext(job) {
    if (job.status !== 'running') return;

    // Update current rate measurement
    this._updateRateMeasurement(job);

    // Check if we've sent all messages
    if (job.currentIndex >= job.totalCount) {
      if (job.status === 'running') await this._completeJob(job);
      return;
    }

    const destination = job.targets[job.currentIndex];

    try {
      const result = await job.sendCallback(destination, job.message, job.overrides);

      if (result && result.success) {
        job.sent++;
        job.consecutiveThrottles = 0;
        job.results.push({
          destination,
          success: true,
          messageId: result.messageId,
          timestamp: new Date().toISOString(),
        });
        job.currentIndex++;
        this._emitProgress(job);
      } else {
        await this._handleFailure(job, destination, result ? result.error : null);
      }
    } catch (error) {
      await this._handleFailure(job, destination, error);
    }
  }

  /**
   * Update the rate measurement (messages per second).
   * @param {object} job
   * @private
   */
  _updateRateMeasurement(job) {
    const now = Date.now();
    const elapsed = (now - job.lastRateCheck) / 1000;
    if (elapsed >= 1) {
      const sentDiff = job.sent - job.lastSentCount;
      job.currentRate = Math.round(elapsed > 0 ? sentDiff / elapsed : 0);
      job.lastRateCheck = now;
      job.lastSentCount = job.sent;
    }
  }

  /**
   * Handle a send failure.
   *
   * Throttle errors: re-queue (decrement index), auto-pause after 10 consecutive throttles.
   * Non-throttle errors: mark as failed and move on.
   *
   * @param {object} job
   * @param {string} destination
   * @param {Error|object} error
   * @private
   */
  async _handleFailure(job, destination, error) {
    const parsed = this.parseSMPPError(error);

    // Emit SMSC error for Event Log
    this.emit('smsc_error', {
      jobId: job.id,
      destination,
      errorCode: parsed.code,
      errorName: parsed.name,
      errorMessage: parsed.message,
      isThrottle: parsed.isThrottle,
    });

    // Handle throttle: re-queue and keep rate constant
    if (parsed.isThrottle) {
      job.consecutiveThrottles++;
      job.throttleCount++;

      if (job.consecutiveThrottles >= 10) {
        // Too many consecutive throttles — pause the job
        this.pauseJob(job.id, 'consecutive_throttle');
        this.emit('rate_updated', {
          jobId: job.id,
          oldRate: job.ratePerSecond,
          newRate: job.ratePerSecond,
          autoReduced: false,
          reason: 'Paused — too many consecutive throttles (10). Resume manually.',
        });
        return;
      }

      // Re-queue this message — decrement index so it gets retried
      // (don't increment index, so the same message sends again)
      this.emit('progress', {
        jobId: job.id,
        sent: job.sent,
        failed: job.failed,
        total: job.totalCount,
        percentage: job.totalCount > 0 ? ((job.sent + job.failed) / job.totalCount) * 100 : 0,
        currentRate: job.currentRate,
        targetRate: job.ratePerSecond,
        eta: null,
        status: job.status,
        message: `Throttled (${job.consecutiveThrottles}/10) — retrying`,
      });
      return;
    }

    // Non-throttle error: mark as permanently failed
    job.failed++;
    job.consecutiveThrottles = 0;
    job.results.push({
      destination,
      success: false,
      error: parsed.message,
      errorCode: parsed.code,
      timestamp: new Date().toISOString(),
    });

    this.emit('message_failed', {
      jobId: job.id,
      destination,
      error: parsed.message,
      errorCode: parsed.code,
      final: true,
    });

    job.currentIndex++;
    this._emitProgress(job);
  }

  /**
   * Emit progress to listeners.
   * @param {object} job
   * @private
   */
  _emitProgress(job) {
    const processed = job.sent + job.failed;
    const remaining = job.totalCount - processed;
    const percentage = job.totalCount > 0 ? (processed / job.totalCount) * 100 : 0;

    let eta = null;
    if (remaining > 0 && job.currentRate > 0) {
      const secs = Math.ceil(remaining / job.currentRate);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      eta = `${m}:${String(s).padStart(2, '0')}`;
    }

    this.emit('progress', {
      jobId: job.id,
      sent: job.sent,
      failed: job.failed,
      total: job.totalCount,
      percentage,
      currentRate: job.currentRate,
      targetRate: job.ratePerSecond,
      eta,
      status: job.status,
    });
  }

  /**
   * Mark a job as completed.
   * @param {object} job
   * @private
   */
  async _completeJob(job) {
    if (job.timeoutId) {
      clearTimeout(job.timeoutId);
      job.timeoutId = null;
    }
    job.status = 'completed';
    const duration = ((Date.now() - job.startTime) / 1000).toFixed(2);

    this.emit('job_completed', {
      jobId: job.id,
      sent: job.sent,
      failed: job.failed,
      total: job.totalCount,
      duration: Number(duration),
      throttleCount: job.throttleCount,
    });

    // Clean up after 5 minutes
    setTimeout(() => {
      if (this.activeJobs.has(job.id)) {
        this.activeJobs.delete(job.id);
      }
    }, 300000);
  }
}

module.exports = ThroughputManager;
