from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

from twilio_sender_provisioning_clock import codes_seen, verdict

T0 = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)
START = T0.timestamp()
HOUR = 3600.0


def at(minutes, **kw):
    row = {"date_sent": format_datetime(T0 + timedelta(minutes=minutes)),
           "from": "+15125550123"}
    row.update(kw)
    return row


def test_a_sender_with_no_provisioning_codes_is_clean():
    state, _ = verdict([at(0), at(5, error_code=30007)], START + HOUR, True)
    assert state == "clean"


def test_two_hours_in_and_still_failing_says_wait():
    rows = [at(0, error_code=30035), at(60, error_code=30035)]
    state, detail = verdict(rows, START + 2 * HOUR, True)
    assert state == "waiting"
    assert "2.0 h ago" in detail
    assert "restarts the clock" in detail


def test_the_same_rows_past_the_window_are_overdue():
    rows = [at(0, error_code=30035), at(60, error_code=30035)]
    state, detail = verdict(rows, START + 30 * HOUR, True)
    assert state == "overdue"
    assert "past the 24 h" in detail


def test_a_success_after_the_last_failure_means_it_already_cleared():
    rows = [at(0, error_code=30035), at(60, error_code=30035), at(120)]
    state, detail = verdict(rows, START + 3 * HOUR, True)
    assert state == "provisioned"
    assert "caught up" in detail


def test_a_sender_in_no_pool_is_never_told_to_wait():
    # Nothing was submitted, so the window is not running. Telling somebody to
    # wait here costs them the whole day.
    state, detail = verdict([at(0, error_code=30035)], START + HOUR, False)
    assert state == "not-in-any-pool"
    assert "waiting will not end it" in detail


def test_a_window_of_only_30024_is_flagged_as_maybe_not_a_clock():
    state, detail = verdict([at(0, error_code=30024)], START + HOUR, True)
    assert state == "waiting"
    assert "destination country" in detail


def test_a_mixed_window_is_not_flagged_that_way():
    rows = [at(0, error_code=30024), at(10, error_code=30035)]
    assert codes_seen(rows) == ["30024", "30035"]
    assert "destination country" not in verdict(rows, START + HOUR, True)[1]


def test_failures_with_no_usable_timestamp_report_that_rather_than_guessing():
    rows = [{"date_sent": "not a date", "error_code": 30035}]
    state, detail = verdict(rows, START + HOUR, True)
    assert state == "undated"
    assert "no clock to read" in detail
