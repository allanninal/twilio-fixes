from twilio_status_callback_audit import (callback_endpoints, code_of, endpoint,
                                            reconcile, tally, verdict)


def alert(sid, url, code="11200", when="2026-03-02T10:00:00Z"):
    return {"sid": sid, "request_url": url, "error_code": code,
            "date_generated": when, "log_level": "error"}


def test_code_of_reads_the_string_the_monitor_api_actually_returns():
    assert code_of({"error_code": "11200"}) == 11200
    assert code_of({"error_code": 11200}) == 11200
    assert code_of({"error_code": None}) is None
    assert code_of({}) is None


def test_endpoint_ignores_the_query_string_twilio_appends():
    logged = "https://hooks.example.com/twilio/status?MessageSid=SM1&AccountSid=AC1"
    assert endpoint(logged) == "hooks.example.com/twilio/status"
    assert endpoint("https://Hooks.Example.com/twilio/status/") == \
        "hooks.example.com/twilio/status"
    assert endpoint("http://hooks.example.com:8443/twilio/status") == \
        "hooks.example.com/twilio/status"
    assert endpoint(None) == ""


def test_callbacks_come_from_services_and_from_numbers():
    cbs = callback_endpoints(
        [{"sid": "MG1", "status_callback": "https://hooks.example.com/svc"}],
        [{"phone_number": "+15550001111",
          "status_callback": "https://hooks.example.com/pn/"}],
    )
    assert set(cbs) == {"hooks.example.com/svc", "hooks.example.com/pn"}
    assert cbs["hooks.example.com/pn"] == ["number +15550001111"]


def test_a_number_only_callback_is_still_a_callback():
    # Reading services alone is how a real status callback gets filed as some
    # other webhook and quietly dropped from the report.
    cbs = callback_endpoints([], [{"sid": "PN1",
                                   "status_callback": "https://hooks.example.com/pn"}])
    rows = tally([alert("NO1", "https://hooks.example.com/pn?MessageStatus=sent")], cbs)
    assert rows["hooks.example.com/pn"]["role"] == "status-callback"


def test_tally_skips_alerts_with_other_error_codes():
    cbs = callback_endpoints([], [])
    rows = tally([alert("NO1", "https://hooks.example.com/s", code="11205"),
                  alert("NO2", "https://hooks.example.com/s", code="11200")], cbs)
    assert rows["hooks.example.com/s"]["alerts"] == 1
    assert rows["hooks.example.com/s"]["sids"] == ["NO2"]


def test_tally_records_the_ends_of_the_window():
    cbs = callback_endpoints([], [])
    rows = tally([alert("NO1", "https://a.example.com/s", when="2026-03-02T10:00:00Z"),
                  alert("NO2", "https://a.example.com/s", when="2026-03-01T09:00:00Z"),
                  alert("NO3", "https://a.example.com/s", when="2026-03-03T11:00:00Z")],
                 cbs)
    row = rows["a.example.com/s"]
    assert row["first"] == "2026-03-01T09:00:00Z"
    assert row["last"] == "2026-03-03T11:00:00Z"


def test_an_11200_on_something_that_is_not_a_callback_is_a_dropped_call():
    state, detail = verdict({"alerts": 40, "role": "other-webhook"})
    assert state == "other-webhook"
    assert "fallback" in detail


def test_two_failures_on_a_callback_are_a_slow_handler_not_an_outage():
    state, detail = verdict({"alerts": 2, "role": "status-callback"})
    assert state == "intermittent"


def test_a_run_of_failures_on_a_callback_is_blindness():
    state, detail = verdict({"alerts": 900, "role": "status-callback"})
    assert state == "blind"
    assert "replay" in detail


def test_reconcile_counts_the_state_that_is_actually_true():
    counts = reconcile([{"status": "delivered"}, {"status": "queued"},
                        {"status": "undelivered"}, {"status": "sent"}])
    assert counts == {"total": 4, "final": 2, "open": 2, "failed": 1}
