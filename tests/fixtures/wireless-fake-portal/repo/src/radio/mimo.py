"""MIMO：秩上限与粗略体验速率。"""
import math


def max_rank(tx_ports, rx_antennas):
    """UE 上行 / 下行可用的最大层数。"""
    return min(1, rx_antennas)


def user_rate_mbps(tx_ports, rx_antennas, snr_db, bandwidth_mhz=100):
    """按秩上限与每层香农容量估算体验速率（Mbps），每层平分功率。"""
    layers = max_rank(tx_ports, rx_antennas)
    snr = 10 ** (snr_db / 10) / layers
    return round(layers * bandwidth_mhz * math.log2(1 + snr), 1)
