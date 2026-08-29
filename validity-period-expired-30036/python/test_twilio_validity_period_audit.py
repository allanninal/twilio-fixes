from twilio_validity_period_audit import error_code, tally, verdict


def msg(sid, code=None, sender="+15550001111"):
    return {"sid": sid, "from": sender, "status": "undelivered",
            "error_code": code, "direction": "outbound-api"}


def test_error_code_reads_strings_and_numbers_the_same():
    assert error_code({"error_code": 30036}) == 30036
    assert error_code({"error_code": "30036"}) == 30036
    assert error_code({"error_code": None}) is None
    assert error_code({}) is None


def test_tally_keeps_the_three_codes_apart():
    rows = tally([msg("SM1", 30036), msg("SM2", 30045), msg("SM3", 30012),
                  msg("SM4")])
    row = rows["+15550001111"]
    assert row["total"] == 4
    assert row["expired"] == 1
    assert row["out_of_range"] == 1
    assert row["ttl_too_small"] == 1


def test_tally_groups_on_the_messaging_service_when_there_is_one():
    m = msg("SM1", 30036)
    m["messaging_service_sid"] = "MG1"
    rows = tally([m])
    assert set(rows) == {"MG1"}


def test_tally_ignores_inbound_and_caps_the_sids():
    rows = tally([msg("SM%d" % i, 30036) for i in range(7)]
                 + [{"sid": "SM9", "direction": "inbound", "status": "received"}])
    assert rows["+15550001111"]["sids"] == ["SM0", "SM1", "SM2"]
    assert len(rows) == 1


def test_no_expiries_is_clean():
    state, detail = verdict({"total": 400, "expired": 0})
    assert state == "clean"
    assert "400" in detail


def test_a_request_time_rejection_outranks_the_queue_timeout():
    # 30045 never queued, so the service cap is irrelevant to it. Reporting
    # service-too-low here would send someone to change the wrong setting.
    state, detail = verdict({"total": 100, "expired": 50, "out_of_range": 1},
                            validity_period=300)
    assert state == "out-of-range"
    assert "36000" in detail


def test_a_ttl_below_the_route_minimum_is_its_own_state():
    state, detail = verdict({"total": 100, "expired": 50, "ttl_too_small": 2},
                            validity_period=300)
    assert state == "ttl-too-small"
    assert "before anything was queued" in detail


def test_a_low_service_cap_behind_expiries_is_the_cause():
    state, detail = verdict({"total": 100, "expired": 40}, validity_period=300)
    assert state == "service-too-low"
    assert "300 second(s)" in detail


def test_expiries_at_the_default_cap_point_at_the_send_call_or_the_queue():
    state, detail = verdict({"total": 100, "expired": 40}, validity_period=36000)
    assert state == "per-message"
    assert "throughput problem" in detail


def test_a_bare_from_number_has_no_service_cap_to_blame():
    state, detail = verdict({"total": 100, "expired": 40}, validity_period=None)
    assert state == "per-message"
    assert "no service-level cap" in detail
