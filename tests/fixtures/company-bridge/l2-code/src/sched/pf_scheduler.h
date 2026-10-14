#pragma once
typedef struct { int ue_id; float avg_kbps; } pf_ue_t;
float cqi_to_spectral_efficiency(int cqi);
void pf_update_avg(pf_ue_t *ue, float served_kbps);
void pf_init_avg(pf_ue_t *ue, int wideband_cqi, float bandwidth_khz);
float pf_priority(const pf_ue_t *ue, float inst_rate_kbps);
