'use strict';

// =============================================================================
// ThroughputManager — Rate-limited SMS sender with SMSC error handling
//
// Sends messages at a controlled rate, handles ESME_RTHROTTLED by reducing
// rate by 50%, retries with exponential backoff, and emits events for all
// SMSC errors so they can be displayed in the Event Log panel.
// =============================================================================

const EventEmitter = require('events');

// ── SMPP Error Codes ────────────────────────────────────────────────────────

const SMPP_ERRORS = {
  0x00000000: { name: 'ESME_ROK',          description: 'Success',                                    isThrottle: false },
  0x00000019: { name: 'ESME_RTHROTTLED',   description: 'Sending too fast — rate limit exceeded',    isThrottle: true  },
  0x0000000D: { name: 'ESME_RINVCMDID',    description: 'Command not supported by SMSC',             isThrottle: false },
  0x0000000E: { name: 'ESME_RINVSRCADDR',  description: 'Invalid source address format',             isThrottle: false },
  0x0000000F: { name: 'ESME_RINVDSTADDR',  description: 'Invalid destination address',               isThrottle: false },
  0x00000014: { name: 'ESME_RINVBDOPT',    description: 'Invalid bind option',                       isThrottle: false },
  0x0000001D: { name: 'ESME_RINVMSGID',    description: 'Invalid message ID',                        isThrottle: false },
  0x00000058: { name: 'ESME_RBINDFAIL',    description: 'Authentication failed',                     isThrottle: false },
  0x00000068: { name: 'ESME_RSUBMITFAIL',  description: 'Submit failed — check source/destination',  isThrottle: false },
  0x00000076: { name: 'ESME_RINVCODING',   description: 'Invalid data coding across segments',       isThrottle: false },
};

// Vendor-specific codes (not in SMPP spec but encountered in practice)
const VENDOR_CODES = {
  104: 'ESME_RSUBMITFAIL (104/0x68) — General submit failure',
  118: 'ESME_RINVCODING (118/0x76) — Inconsistent data_coding across concatenated segments',
};

// ── ThroughputManager ──────────────────────────────────────────────────────

/**
 * @class ThroughputManager
 * @extends EventEmitter
 *
 * Emits the following events:
 *   - job_started({ jobId, totalCount, rate })
 *   - progress({ jobId, sent, failed, total, percentage, currentRate, targetRate, eta, retryCount, status })
 *   - smsc_error({ jobId, destination, errorCode, errorName, errorMessage, isThrottle, retryCount })
 *   - job_paused({ jobId, reason })
 *   - job_resumed({ jobId, rate })
 *   - job_completed({ jobId, sent, failed, total, duration, retryCount, throttleCount })
 *   - rate_updated({ jobId, oldRate, newRate, autoReduced })
 *   - message_retry({ jobId, destination, retryCount, maxRetries, error })
 *   - message_failed({ jobId, destination, error, errorCode, final })
 *   - job_stopped({ jobId, sent, failed })
 */
class ThroughputManager extends EventEmitter {

  constructor() {
    super();
    this.activeJobs = new Map();
    this.nextJobId = 1;
  }

  // ── Error Parsing ──────────────────────────────────────────────────────────

  /**
   * Parse an SMSC error to extract code, name, description and throttle flag.
   * @param {Error|object|number} error
   * @returns {{ code: string|null, name: string, message: string, isThrottle: boolean }}
   */
  parseSMPPError(error) {
    let errorCode = null;

    if (typeof error === 'number') {
      errorCode = error;
    } else if (error && error.command_status !== undefined) {
      errorCode = Number(error.command_status);
    } else if (error && error.code) {
      errorCode = Number(error.code);
    } else if (error && error.message) {
      // Try to extract hex code from message string
      const hexMatch = String(error.message).match(/0x[0-9A-Fa-f]{8}/);
      if (hexMatch) errorCode = parseInt(hexMatch[0], 16);

      // Also try numeric code from patterns like "Submit error 25 (...)"
      if (!errorCode) {
        const numMatch = String(error.message).match(/Submit error (\d+)/);
        if (numMatch) errorCode = parseInt(numMatch[1], 10);
      }
    }

    // Look up in standard codes map
    let info = SMPP_ERRORS[errorCode];

    // If not found, try vendor lookup by numeric code
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
   * @param {string[]} options.destinations        Array of destination MSISDNs
   * @param {string}   options.message             SMS message content
   * @param {number}   options.ratePerSecond       Target rate (1-100 msg/s)
   * @param {number}   [options.maxRetries=3]      Max retries per destination
   * @param {object}   [options.overrides={}]      SMPP parameter overrides
   * @param {Function} options.sendCallback        async (dest, msg, overrides, retryCount) => { success, messageId, error?, command_status? }
   * @returns {string} jobId
   */
  createJob(options) {
    const {
      destinations,
      message,
      ratePerSecond,
      totalCount,
      maxRetries = 3,
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

    // Expand destinations cyclically to reach totalCount.
    // E.g. 1 destination + totalCount=100 → repeats that dest 100x.
    // E.g. 3 destinations + totalCount=10 → cycles through them 4+3+3 times.
    const desiredTotal = (totalCount !== undefined && totalCount > 0) ? totalCount : destinations.length;
    const targets = [];
    for (let i = 0; i < desiredTotal; i++) {
      targets.push(destinations[i % destinations.length]);
    }

    // Per-destination retry counter (unique destinations only)
    const retryMap = new Map();
    [...new Set(destinations)].forEach(dest => retryMap.set(dest, 0));

    const job = {
      id: jobId,
      targets,
      message,
      ratePerSecond: Math.min(Math.max(ratePerSecond, 1), 100),
      totalCount: targets.length,
      maxRetries: Math.max(0, Math.min(maxRetries, 10)),
      overrides,
      sendCallback,

      status: 'idle',              // idle | running | paused | stopped | completed
      sent: 0,
      failed: 0,
      retryCount: 0,
      throttleCount: 0,
      results: [],
      currentIndex: 0,
      timeoutId: null,
      startTime: null,
      lastRateCheck: null,
      lastSentCount: 0,
      currentRate: 0,

      retryMap,
      failedDestinations: new Map(),
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

    // Use recursive setTimeout instead of setInterval so each _processNext
    // completes fully before the next is scheduled. This prevents concurrent
    // _processNext calls from stacking up when send takes longer than the
    // interval, which would cause SMPP window congestion and rate inaccuracy.
    const scheduleNext = () => {
      if (job.status !== 'running') return;
      const intervalMs = Math.max(10, Math.floor(1000 / job.ratePerSecond));
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
   * @param {boolean} [autoReduced=false]
   * @returns {boolean}
   */
  updateJobRate(jobId, newRate, autoReduced = false) {
    const job = this.activeJobs.get(jobId);
    if (!job) return false;

    const oldRate = job.ratePerSecond;
    job.ratePerSecond = Math.min(Math.max(newRate, 1), 100);

    // Rate will take effect on the next tick (recursive setTimeout handles this)
    this.emit('rate_updated', { jobId, oldRate, newRate: job.ratePerSecond, autoReduced });
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
      retryCount: job.retryCount,
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
    const retryCount = job.retryMap.get(destination) || 0;

    try {
      const result = await job.sendCallback(destination, job.message, job.overrides, retryCount);

      if (result && result.success) {
        job.sent++;
        job.retryMap.set(destination, 0);
        job.failedDestinations.delete(destination);
        job.results.push({
          destination,
          success: true,
          messageId: result.messageId,
          timestamp: new Date().toISOString(),
        });
      } else {
        await this._handleFailure(job, destination, result ? result.error : null, retryCount);
        return; // _handleFailure will decrement index for retries
      }
    } catch (error) {
      await this._handleFailure(job, destination, error, retryCount);
      return; // _handleFailure will decrement index for retries
    }

    job.currentIndex++;
    this._emitProgress(job);
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
   * Handle a send failure with retry logic and throttle detection.
   * @param {object} job
   * @param {string} destination
   * @param {Error|object} error
   * @param {number} retryCount
   * @private
   */
  async _handleFailure(job, destination, error, retryCount) {
    const parsed = this.parseSMPPError(error);

    // Emit SMSC error for Event Log
    this.emit('smsc_error', {
      jobId: job.id,
      destination,
      errorCode: parsed.code,
      errorName: parsed.name,
      errorMessage: parsed.message,
      isThrottle: parsed.isThrottle,
      retryCount,
    });

    // Handle throttle: reduce rate by 50%
    if (parsed.isThrottle) {
      job.throttleCount++;
      const newRate = Math.max(1, Math.floor(job.ratePerSecond * 0.5));
      if (newRate !== job.ratePerSecond) {
        this.updateJobRate(job.id, newRate, true);
      }

      // Pause after 3 consecutive throttles
      if (job.throttleCount >= 3) {
        this.pauseJob(job.id, 'throttle');
        this.emit('job_paused', {
          jobId: job.id,
          reason: 'throttle',
          message: 'Job paused due to repeated SMSC throttling — manual resume required',
        });
        return;
      }

      // Re-queue this message for retry (decrement index)
      job.currentIndex--;
      return;
    }

    // Non-throttle error: check retry budget
    if (retryCount < job.maxRetries) {
      const newRetryCount = retryCount + 1;
      job.retryMap.set(destination, newRetryCount);
      job.retryCount++;

      // Re-queue for retry
      job.currentIndex--;

      this.emit('message_retry', {
        jobId: job.id,
        destination,
        retryCount: newRetryCount,
        maxRetries: job.maxRetries,
        error: parsed.message,
      });

      // Exponential backoff before retry
      const delayMs = Math.min(1000 * Math.pow(2, newRetryCount), 30000);
      await this._sleep(delayMs);
    } else {
      // Max retries exceeded — mark as permanently failed
      job.failed++;
      job.failedDestinations.set(destination, {
        error: parsed.message,
        errorCode: parsed.code,
        retries: retryCount,
      });
      job.results.push({
        destination,
        success: false,
        error: parsed.message,
        errorCode: parsed.code,
        retries: retryCount,
        timestamp: new Date().toISOString(),
      });

      this.emit('message_failed', {
        jobId: job.id,
        destination,
        error: parsed.message,
        errorCode: parsed.code,
        final: true,
      });
    }
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
      retryCount: job.retryCount,
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
      retryCount: job.retryCount,
      throttleCount: job.throttleCount,
    });

    // Clean up after 5 minutes
    setTimeout(() => {
      if (this.activeJobs.has(job.id)) {
        this.activeJobs.delete(job.id);
      }
    }, 300000);
  }

  /**
   * Promise-based sleep for exponential backoff.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ThroughputManager;
