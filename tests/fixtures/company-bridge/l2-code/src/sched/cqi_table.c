/* 38.214 表 5.2.2.1-2（64QAM）频谱效率，CQI 0 表示超出范围。 */
static const float k_se[16] = { 0.0f, 0.1523f, 0.2344f, 0.3770f, 0.6016f, 0.8770f, 1.1758f, 1.4766f,
                                1.9141f, 2.4063f, 2.7305f, 3.3223f, 3.9023f, 4.5234f, 5.1152f, 5.5547f };
float cqi_to_spectral_efficiency(int cqi) { return (cqi < 0 || cqi > 15) ? 0.0f : k_se[cqi]; }
