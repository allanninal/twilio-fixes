import datetime as dt

from twilio_pumping_block_audit import country_prefix, tally, verdict

NOW = dt.datetime(2026, 3, 2, 12, 0, tzinfo=dt.timezone.utc)


def blocked(sid, to, sent):
    return {"sid": sid, "to": to, "error_code": 30450, "status": "failed",
            "date_sent": sent}


def test_dialling_codes_match_longest_first():
    assert country_prefix("+8801711000000") == "880"
    assert country_prefix("+447700900000") == "44"
    assert country_prefix("+15551230000") == "1"


def test_prefix_of_junk_is_not_a_crash():
    assert country_prefix(None) == "unknown"
    assert country_prefix("not a number") == "unknown"


def test_error_code_as_a_string_still_counts():
    rows = tally([{"sid": "SM1", "to": "+8801711000000", "error_code": "30450",
                   "date_sent": "Mon, 02 Mar 2026 09:00:00 +0000"}], NOW)
    assert rows["880"]["blocked"] == 1


def test_tally_groups_by_prefix_and_skips_inbound():
    rows = tally([
        blocked("SM1", "+8801711000000", "Mon, 02 Mar 2026 09:00:00 +0000"),
        blocked("SM2", "+8801711000001", "Mon, 02 Mar 2026 09:11:00 +0000"),
        {"sid": "SM3", "to": "+15551230000", "status": "delivered"},
        {"sid": "SM4", "to": "+15551230000", "direction": "inbound"},
    ], NOW)
    assert sorted(rows) == ["1", "880"]
    assert rows["880"]["blocked"] == 2
    assert rows["880"]["span_minutes"] == 11
    assert rows["880"]["minutes_since_last"] == 169
    assert rows["1"]["total"] == 1


def test_a_burst_that_already_stopped_reads_as_recovered():
    state, detail = verdict({"total": 400, "blocked": 94, "span_minutes": 11,
                             "minutes_since_last": 169})
    assert state == "recovered"
    assert "lifted by itself" in detail


def test_a_prefix_still_failing_now_is_an_outage_not_a_blip():
    state, detail = verdict({"total": 10, "blocked": 8, "span_minutes": 600,
                             "minutes_since_last": 4})
    assert state == "region-blocked"
    assert "outage" in detail


def test_recurring_low_rate_is_intermittent():
    state, _ = verdict({"total": 500, "blocked": 40, "span_minutes": 3000,
                        "minutes_since_last": 6})
    assert state == "intermittent"


def test_two_blocked_is_too_few_to_escalate():
    state, detail = verdict({"total": 50, "blocked": 2, "span_minutes": 3,
                             "minutes_since_last": 400})
    assert state == "isolated"
    assert "at least 3" in detail


def test_no_blocked_messages_is_clean():
    state, detail = verdict({"total": 900, "blocked": 0})
    assert state == "clean"
    assert "900" in detail


def test_sids_are_capped_at_the_three_support_asks_for():
    rows = tally([blocked("SM%d" % i, "+8801711000000",
                          "Mon, 02 Mar 2026 09:00:00 +0000") for i in range(9)], NOW)
    assert rows["880"]["sids"] == ["SM0", "SM1", "SM2"]
    assert rows["880"]["blocked"] == 9
