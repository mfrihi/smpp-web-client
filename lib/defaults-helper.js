/**
 * Build a defaults object from sessionState.config.
 * Pulls all SMPP fields that the user can configure via the defaults panel.
 */
function smppDefaultsFromConfig(cfg) {
  return {
    source_addr: cfg.source_addr || cfg.system_id || 'MyApp',
    source_addr_ton: cfg.source_addr_ton !== undefined ? Number(cfg.source_addr_ton) : 1,
    source_addr_npi: cfg.source_addr_npi !== undefined ? Number(cfg.source_addr_npi) : 1,
    dest_addr_ton: cfg.dest_addr_ton !== undefined ? Number(cfg.dest_addr_ton) : 1,
    dest_addr_npi: cfg.dest_addr_npi !== undefined ? Number(cfg.dest_addr_npi) : 1,
    registered_delivery: cfg.registered_delivery !== undefined ? Number(cfg.registered_delivery) : 1,
    ...(cfg.data_coding !== undefined ? { data_coding: Number(cfg.data_coding) } : {}),
    ...(cfg.priority_flag !== undefined ? { priority_flag: Number(cfg.priority_flag) } : {}),
    ...(cfg.service_type ? { service_type: cfg.service_type } : {}),
    ...(cfg.esm_class !== undefined ? { esm_class: Number(cfg.esm_class) } : {}),
    ...(cfg.protocol_id !== undefined ? { protocol_id: Number(cfg.protocol_id) } : {}),
    ...(cfg.replace_if_present_flag !== undefined ? { replace_if_present_flag: Number(cfg.replace_if_present_flag) } : {}),
    ...(cfg.sm_default_msg_id !== undefined ? { sm_default_msg_id: Number(cfg.sm_default_msg_id) } : {}),
    ...(cfg.schedule_delivery_time ? { schedule_delivery_time: cfg.schedule_delivery_time } : {}),
    ...(cfg.validity_period ? { validity_period: cfg.validity_period } : {}),
  };
}
