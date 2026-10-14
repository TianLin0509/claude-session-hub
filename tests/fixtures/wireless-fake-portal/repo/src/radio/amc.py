"""AMC：CQI 到 MCS 的映射（4 bit CQI，表 1）。"""

# 下标是 CQI（0–15）。CQI 0 在 38.214 里表示 out of range（信道太差，不应调度）。
CQI_TO_MCS = [0, 0, 2, 4, 6, 8, 11, 13, 15, 18, 20, 22, 24, 26, 28, 28]


def cqi_to_mcs(cqi):
    """返回该 CQI 对应的 MCS；超出范围时返回 None（不调度）。"""
    if not 0 <= cqi <= 15:
        return None
    return CQI_TO_MCS[cqi]
