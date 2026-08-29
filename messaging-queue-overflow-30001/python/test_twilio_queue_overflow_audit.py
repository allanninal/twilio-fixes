from twilio_queue_overflow_audit import queue_hours, tally, verdict


def sent(sid, sender, **extra):
    row = {"sid": sid, "from": sender, "status": "delivered", "num_segments": 1}
    row.update(extra)
    return row


def test_ten_hours_is_thirty_six_thousand_segments_at_one_mps():
    assert queue_hours(36000, 1) == 10.0
    assert round(queue_hours(3600, 0.5), 1) == 2.0


def test_a_zero_rate_does_not_divide_by_zero():
    assert queue_hours(100, 0) > 0


def test_tally_groups_by_sending_number_and_counts_segments():
    rows = tally([
        sent("SM1", "+15550001111", num_segments="3"),
        sent("SM2", "+15550001111", status="queued"),
        sent("SM3", "+15550002222", messaging_service_sid="MG1"),
        {"sid": "SM4", "from": "+15550001111", "direction": "inbound"},
    ])
    assert sorted(rows) == ["+15550001111", "+15550002222"]
    assert rows["+15550001111"]["segments"] == 4
    assert rows["+15550001111"]["queued"] == 1
    assert rows["+15550001111"]["service"] is None
    assert rows["+15550002222"]["service"] == "MG1"


def test_both_error_codes_count_as_the_same_wall():
    rows = tally([
        sent("SM1", "+1555", error_code=30001, status="failed"),
        sent("SM2", "+1555", error_code="21611", status="failed"),
        sent("SM3", "+1555"),
    ])
    assert rows["+1555"]["overflow"] == 2
    assert rows["+1555"]["sids"] == ["SM1", "SM2"]


def test_overflow_errors_are_the_headline():
    state, detail = verdict({"total": 40000, "overflow": 6000, "segments": 40000,
                             "service": "MG1"})
    assert state == "overflow"
    assert "11.1 hours" in detail


def test_a_sender_past_the_queue_depth_is_flagged_before_it_fails():
    state, detail = verdict({"total": 40000, "segments": 40000, "service": "MG1"})
    assert state == "over-capacity"
    assert "Nothing failed yet" in detail


def test_half_the_queue_is_already_worth_saying():
    state, detail = verdict({"total": 20000, "segments": 20000, "service": "MG1"})
    assert state == "near-capacity"
    assert "UCS-2" in detail


def test_a_bare_from_says_so():
    _, detail = verdict({"total": 40000, "segments": 40000})
    assert "bare From" in detail


def test_messages_still_waiting_are_draining_not_broken():
    state, detail = verdict({"total": 900, "segments": 900, "queued": 40,
                             "service": "MG1"})
    assert state == "draining"
    assert "40 message(s)" in detail


def test_a_small_run_is_clean():
    state, detail = verdict({"total": 100, "segments": 100, "service": "MG1"})
    assert state == "clean"
    assert "100 segment(s)" in detail


def test_three_segment_bodies_fill_the_queue_three_times_faster():
    # The same 18,000 messages, one segment each and then three each.
    assert verdict({"total": 18000, "segments": 18000, "service": "MG1"})[0] == "near-capacity"
    assert verdict({"total": 18000, "segments": 54000, "service": "MG1"})[0] == "over-capacity"
