from twilio_reply_loop_audit import classify_pair, densest_window


def pair_traffic(count, start=0.0, step=0.8, alternating=True, body="Thanks!"):
    """A dense exchange between two numbers, one message every `step` seconds."""
    rows = []
    for i in range(count):
        direction = ("inbound" if i % 2 else "outbound-reply") if alternating else "outbound-api"
        rows.append({"direction": direction, "body": body, "at": start + i * step})
    return rows


def test_a_window_straddling_a_minute_boundary_is_still_one_burst():
    # 30 messages from 12:00:45 to 12:01:15. Clock buckets would see 15 and 15.
    stamps = [45.0 + i for i in range(30)]
    assert densest_window(stamps, 30) == 30


def test_sparse_traffic_has_a_low_peak():
    assert densest_window([0, 60, 120, 180], 30) == 1


def test_an_alternating_burst_at_the_ceiling_is_a_reply_loop():
    state, detail = classify_pair(pair_traffic(34))
    assert state == "reply-loop"
    assert "both directions" in detail
    assert "outbound-reply" in detail


def test_a_one_directional_burst_is_not_a_reply_loop():
    state, detail = classify_pair(pair_traffic(34, alternating=False))
    assert state == "one-way-burst"
    assert "retry storm" in detail


def test_a_loop_running_under_the_limit_is_still_reported():
    # Nothing has failed, nothing will stop it, and it bills every segment.
    state, detail = classify_pair(pair_traffic(8, step=3.0))
    assert state == "echo"
    assert "Under the limit" in detail


def test_ordinary_conversation_is_left_alone():
    rows = [{"direction": "inbound", "body": "hi", "at": 0.0},
            {"direction": "outbound-reply", "body": "hello", "at": 40.0},
            {"direction": "inbound", "body": "thanks", "at": 200.0}]
    assert classify_pair(rows)[0] == "normal"


def test_an_empty_history_is_its_own_state():
    assert classify_pair([])[0] == "quiet"


def test_missing_timestamps_do_not_crash_the_window():
    rows = [{"direction": "inbound", "body": "hi", "at": None},
            {"direction": "outbound-reply", "body": "hi", "at": 1.0}]
    assert classify_pair(rows)[0] == "normal"
