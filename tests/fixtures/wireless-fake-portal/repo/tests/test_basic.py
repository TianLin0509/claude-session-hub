from radio.amc import cqi_to_mcs
from radio.harq import next_transmission
from radio.mimo import max_rank, user_rate_mbps


def test_new_data_is_sent():
    assert next_transmission(1500, False) == "new"


def test_retx_has_priority_over_new_data():
    assert next_transmission(1500, True) == "retx"


def test_nothing_to_send():
    assert next_transmission(0, False) is None


def test_cqi_table_top():
    assert cqi_to_mcs(15) == 28
    assert cqi_to_mcs(16) is None


def test_single_port_rank():
    assert max_rank(1, 4) == 1
    assert user_rate_mbps(1, 4, 20) > 0
