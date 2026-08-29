import datetime

from twilio_notify_eol_audit import binding_count, days_past_eol, verdict


def service(sid="IS01", name="push"):
    return {"sid": sid, "friendly_name": name}


def test_an_account_with_no_notify_services_is_clear():
    state, detail = verdict([])
    assert state == "clear"
    assert "no Notify services" in detail


def test_services_with_unread_bindings_stay_unknown_rather_than_abandoned():
    state, detail = verdict([service()])
    assert state == "unchecked"
    assert "not read" in detail


def test_bindings_still_registered_is_the_finding_that_gets_scheduled():
    state, detail = verdict([service("IS01"), service("IS02")],
                            {"IS01": 11000, "IS02": 4})
    assert state == "registered"
    assert "at least 11004" in detail


def test_no_bindings_anywhere_is_cleanup_rather_than_an_outage():
    state, detail = verdict([service()], {"IS01": 0})
    assert state == "abandoned"
    assert "deletion to schedule" in detail


def test_a_service_missing_from_the_bindings_map_counts_as_zero():
    assert verdict([service("IS09")], {"IS01": 3})[0] == "abandoned"


def test_binding_count_takes_strings_and_refuses_to_raise_on_junk():
    assert binding_count({"IS01": "12"}, "IS01") == 12
    assert binding_count({"IS01": "many"}, "IS01") == 0
    assert binding_count({"IS01": -4}, "IS01") == 0
    assert binding_count(None, "IS01") == 0


def test_days_past_eol_counts_forward_from_the_end_of_life_date():
    assert days_past_eol(datetime.date(2026, 1, 31)) == 31
    assert days_past_eol(datetime.date(2025, 12, 1)) == -30
