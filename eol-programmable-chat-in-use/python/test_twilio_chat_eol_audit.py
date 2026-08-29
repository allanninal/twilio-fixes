import datetime

from twilio_chat_eol_audit import days_since_touched, deadline, parse_when, verdict


def chat(**kw):
    service = {"sid": "IS01", "friendly_name": "support",
               "date_created": "2019-04-02T11:00:00Z",
               "date_updated": "2021-08-19T14:32:00Z"}
    service.update(kw)
    return service


def test_an_account_with_no_chat_services_is_clear():
    state, detail = verdict([], [{"sid": "IS90"}])
    assert state == "clear"
    assert "no Programmable Chat" in detail


def test_chat_services_and_no_conversations_means_nothing_has_moved():
    state, detail = verdict([chat()], [])
    assert state == "not-started"
    assert "no automated migration" in detail


def test_both_products_present_is_the_half_finished_migration():
    state, detail = verdict([chat()], [{"sid": "IS90"}, {"sid": "IS91"}])
    assert state == "in-progress"
    assert "recorded internally as finished" in detail


def test_after_the_date_the_account_is_running_unsupported():
    urgency, text = deadline(datetime.date(2026, 8, 30))
    assert urgency == "past"
    assert "90 day(s) past" in text


def test_inside_ninety_days_is_soon_and_beyond_it_is_ahead():
    assert deadline(datetime.date(2026, 5, 1))[0] == "soon"
    assert deadline(datetime.date(2025, 1, 1))[0] == "ahead"


def test_staleness_comes_from_the_most_recently_touched_service():
    services = [chat(date_updated="2021-08-19T14:32:00Z"),
                chat(date_updated="2026-08-20T09:00:00Z")]
    assert days_since_touched(services, datetime.date(2026, 8, 30)) == 10


def test_a_service_with_no_usable_timestamp_yields_no_staleness():
    assert days_since_touched([{"sid": "IS02"}], datetime.date(2026, 8, 30)) is None
    assert days_since_touched([], datetime.date(2026, 8, 30)) is None


def test_date_created_stands_in_when_date_updated_is_missing():
    service = {"sid": "IS03", "date_created": "2026-08-25T00:00:00Z"}
    assert days_since_touched([service], datetime.date(2026, 8, 30)) == 5


def test_parse_when_reads_iso_8601_and_refuses_anything_else():
    assert parse_when("2024-03-11T09:12:00Z") is not None
    assert parse_when("Tue, 18 Apr 2023 09:12:00 +0000") is None
    assert parse_when("") is None
