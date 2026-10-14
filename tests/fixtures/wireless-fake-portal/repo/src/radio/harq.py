"""下行 HARQ：决定本时隙发什么。"""


def next_transmission(new_data_bytes, pending_retx):
    """返回本时隙要发的内容：'retx'（重传）、'new'（新传）或 None（不发）。

    new_data_bytes: 缓存里还有多少新数据（字节）
    pending_retx: 是否有已到重传时机的 HARQ 进程
    """
    if new_data_bytes <= 0:
        return None
    if pending_retx:
        return "retx"
    return "new"
