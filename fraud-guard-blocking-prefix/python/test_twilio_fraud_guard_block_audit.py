from twilio_fraud_guard_block_audit import group_attempts, prefix_of, verdict

GROUP = {"country": "GB", "prefix": "+447700", "attempts": 44, "sample": "+447700900123"}


def test_live_block_is_the_incident():
    state, detail = verdict(GROUP, {"number_blocked": True,
                                    "number_blocked_date": "2026-08-29",
                                    "sms_pumping_risk_score": 97,
                                    "carrier_risk_category": "high"})
    assert state == "blocked"
    assert "60410" in detail
    assert "no unblock API" in detail


def test_blocked_before_but_not_now_is_a_source_problem():
    state, detail = verdict(GROUP, {"number_blocked": False,
                                    "number_blocked_last_3_months": 2,
                                    "sms_pumping_risk_score": 71})
    assert state == "blocked-recently"
    assert "block again" in detail


def test_high_score_with_no_block_yet_is_its_own_state():
    state, detail = verdict(GROUP, {"number_blocked": False,
                                    "number_blocked_last_3_months": 0,
                                    "sms_pumping_risk_score": 94})
    assert state == "high-risk"
    assert "before it does" in detail


def test_middle_band_asks_for_friction_not_a_block():
    state, _ = verdict(GROUP, {"number_blocked": False,
                               "number_blocked_last_3_months": 0,
                               "sms_pumping_risk_score": 66})
    assert state == "watch"


def test_missing_pumping_risk_is_never_reported_as_clear():
    # An unentitled field and a clean number look the same in the response.
    state, detail = verdict(GROUP, None)
    assert state == "no-risk-data"
    assert "entitlement-gated" in detail


def test_a_handful_of_attempts_is_not_a_cluster():
    state, _ = verdict({"country": "GB", "prefix": "+447700", "attempts": 2},
                       {"number_blocked": True})
    assert state == "thin"


def test_attempts_group_by_country_and_prefix_keeping_a_sample():
    groups = group_attempts([
        {"country": "GB", "channel_data": {"to": "+447700900123"}},
        {"country": "GB", "channel_data": {"to": "+447700900456"}},
        {"country": "FR", "channel_data": {"to": "+33612345678"}},
    ])
    assert groups[0]["prefix"] == "+447700"
    assert groups[0]["attempts"] == 2
    assert groups[0]["sample"] == "+447700900123"
    assert prefix_of("+33 6 12 34 56 78") == "+336123"
