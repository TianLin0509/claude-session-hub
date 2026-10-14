/* PF 调度：优先级 = 瞬时速率 / 平均吞吐。 */
#include "pf_scheduler.h"

#define PF_FORGET_SHIFT   6          /* 遗忘因子 alpha = 1/64，每个 TTI 都更新 */
#define PF_INIT_DISCOUNT  0.8f       /* 新 UE 初值折扣 */
#define PF_INIT_CAP_KBPS  200000.0f  /* 新 UE 初值上限：200 Mbps */

/* 每个 TTI 对所有激活 UE 调用；没被调度的 UE 传入 served_kbps = 0，同样参与衰减。 */
void pf_update_avg(pf_ue_t *ue, float served_kbps)
{
    float alpha = 1.0f / (float)(1 << PF_FORGET_SHIFT);
    ue->avg_kbps = (1.0f - alpha) * ue->avg_kbps + alpha * served_kbps;
}

/* 新接入 UE：用接入时上报的宽带 CQI 查频谱效率，乘以带宽，再打折、封顶。 */
void pf_init_avg(pf_ue_t *ue, int wideband_cqi, float bandwidth_khz)
{
    float se = cqi_to_spectral_efficiency(wideband_cqi);   /* bit/s/Hz，见 cqi_table.c */
    float est = se * bandwidth_khz * PF_INIT_DISCOUNT;
    ue->avg_kbps = est > PF_INIT_CAP_KBPS ? PF_INIT_CAP_KBPS : est;
}

float pf_priority(const pf_ue_t *ue, float inst_rate_kbps)
{
    float avg = ue->avg_kbps < 1.0f ? 1.0f : ue->avg_kbps;
    return inst_rate_kbps / avg;
}
