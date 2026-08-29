from datetime import datetime, timedelta, timezone

from twilio_verify_check_attempts_audit import age_seconds, parse_time, verdict

NOW = datetime(2026, 3, 4, 12, 0, 0, tzinfo=timezone.utc)


def iso(seconds_ago):
    return (NOW - timedelta(seconds=seconds_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def test_404_is_resolved_not_an_error():
    state, detail = verdict(404, None, NOW)
    assert state == "resolved"
    assert "soft deleted" in detail


def test_burned_inside_the_lifetime_is_someone_waiting_now():
    state, detail = verdict(200, {"status": "max_attempts_reached",
                                  "date_created": iso(120)}, NOW)
    assert state == "burned-live"
    assert "another 480s" in detail


def test_burned_after_the_lifetime_is_only_a_statistic():
    state, detail = verdict(200, {"status": "max_attempts_reached",
                                  "date_created": iso(3600)}, NOW)
    assert state == "burned-cold"
    assert "Nobody is stuck" in detail


def test_burned_with_an_unreadable_clock_is_still_burned():
    state, detail = verdict(200, {"status": "max_attempts_reached",
                                  "date_created": "not a date"}, NOW)
    assert state == "burned"
    assert "unreadable" in detail


def test_pending_and_approved_are_left_alone():
    assert verdict(200, {"status": "pending"}, NOW)[0] == "pending"
    assert verdict(200, {"status": "approved"}, NOW)[0] == "approved"


def test_an_unrecognised_status_is_reported_rather_than_assumed_healthy():
    state, detail = verdict(200, {"status": "expired"}, NOW)
    assert state == "unknown"
    assert "expired" in detail


def test_timestamps_with_a_trailing_z_parse_on_3_9():
    assert parse_time("2026-03-04T11:58:00Z") is not None
    assert parse_time("") is None
    assert age_seconds(iso(60), NOW) == 60
