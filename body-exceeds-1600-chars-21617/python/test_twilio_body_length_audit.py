from twilio_body_length_audit import alert_summary, tally, verdict


def alert(sid, code, when="2026-03-02T09:00:00Z"):
    return {"sid": sid, "error_code": code, "date_generated": when}


def test_monitor_returns_error_code_as_a_string():
    # The whole audit reports nothing if this comparison is done on the raw value.
    out = alert_summary([alert("NO1", "21617")])
    assert out["count"] == 1


def test_summary_ignores_other_error_codes():
    out = alert_summary([alert("NO1", "11200"), alert("NO2", "21617")])
    assert out["count"] == 1
    assert out["sids"] == ["NO2"]


def test_summary_keeps_the_first_and_last_rejection():
    out = alert_summary([
        alert("NO1", "21617", "2026-03-02T09:00:00Z"),
        alert("NO2", "21617", "2026-02-25T04:30:00Z"),
        alert("NO3", "21617", "2026-03-04T18:00:00Z"),
    ])
    assert out["count"] == 3
    assert out["first"].day == 25
    assert out["last"].day == 4


def test_alert_sids_are_capped_at_three():
    out = alert_summary([alert("NO%d" % i, "21617") for i in range(7)])
    assert out["sids"] == ["NO0", "NO1", "NO2"]
    assert out["count"] == 7


def test_tally_keeps_the_longest_body_per_sender_and_skips_inbound():
    rows = tally([
        {"sid": "SM1", "from": "+15550001111", "body": "x" * 40},
        {"sid": "SM2", "from": "+15550001111", "body": "x" * 1250},
        {"sid": "SM3", "from": "+15550001111", "direction": "inbound", "body": "y" * 90},
        {"sid": "SM4", "messaging_service_sid": "MG1", "from": "+15550001111",
         "body": "z" * 20},
    ])
    assert sorted(rows) == ["+15550001111", "MG1"]
    assert rows["+15550001111"]["longest"] == 1250
    assert rows["+15550001111"]["near"] == 1
    assert rows["+15550001111"]["sids"] == ["SM2"]


def test_eight_segments_counts_as_near_even_on_a_short_body():
    # num_segments is the near-miss signal when the body was truncated in transit
    # or the encoding inflated it.
    rows = tally([{"sid": "SM1", "from": "+1555", "body": "x" * 600,
                   "num_segments": "9"}])
    assert rows["+1555"]["near"] == 1


def test_a_body_past_the_warning_line_is_near_limit():
    state, detail = verdict({"total": 900, "longest": 1250, "near": 4})
    assert state == "near-limit"
    assert "350 to spare" in detail
    assert "21617" in detail


def test_a_long_but_safe_body_is_only_long():
    state, detail = verdict({"total": 900, "longest": 400})
    assert state == "long"
    assert "ceiling" in detail


def test_short_bodies_are_fine():
    state, detail = verdict({"total": 900, "longest": 120})
    assert state == "fine"
    assert "120" in detail
