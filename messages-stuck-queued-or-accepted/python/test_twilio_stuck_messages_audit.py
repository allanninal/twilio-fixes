import datetime as dt

from twilio_stuck_messages_audit import age_minutes, verdict

NOW = dt.datetime(2026, 1, 1, 12, 0, tzinfo=dt.timezone.utc)


def rfc2822(hour, minute=0, day=1):
    return "Thu, %02d Jan 2026 %02d:%02d:00 +0000" % (day, hour, minute)


def test_age_is_read_from_rfc_2822_not_iso_8601():
    assert age_minutes(rfc2822(9), NOW) == 180
    assert age_minutes(rfc2822(14), NOW) == -120     # in the future
    assert age_minutes("2026-01-01T09:00:00Z", NOW) is None
    assert age_minutes("", NOW) is None
    assert age_minutes(None, NOW) is None


def test_four_hours_queued_with_no_error_code_is_stuck():
    state, detail = verdict({"status": "queued", "date_created": rfc2822(8)}, NOW)
    assert state == "stuck"
    assert "30036" in detail


def test_ten_minutes_queued_is_still_in_flight():
    state, _ = verdict({"status": "accepted", "date_created": rfc2822(11, 50)}, NOW)
    assert state == "in-flight"


def test_a_scheduled_message_is_not_stuck_however_old_the_row_is():
    state, detail = verdict({"status": "scheduled", "date_created": rfc2822(1),
                             "send_at": rfc2822(9, 0, day=8)}, NOW)
    assert state == "scheduled"
    assert "No status callback" in detail


def test_a_scheduled_message_whose_time_has_passed_is_a_finding():
    state, _ = verdict({"status": "scheduled", "send_at": rfc2822(9)}, NOW)
    assert state == "scheduled-overdue"


def test_sent_with_no_receipt_is_success_not_failure():
    state, detail = verdict({"status": "sent", "date_created": rfc2822(8)}, NOW)
    assert state == "sent-no-dlr"
    assert "success" in detail


def test_delivered_and_failed_are_both_final():
    assert verdict({"status": "delivered"}, NOW)[0] == "final"
    assert verdict({"status": "failed", "error_code": 30003}, NOW)[0] == "final"


def test_an_unreadable_date_is_reported_as_unreadable():
    state, detail = verdict({"status": "queued", "date_created": "yesterday"}, NOW)
    assert state == "unknown-age"
    assert "cannot" in detail
    assert verdict({"status": "partially_delivered"}, NOW)[0] == "unknown-status"


def test_the_threshold_is_an_argument_not_a_constant():
    msg = {"status": "queued", "date_created": rfc2822(11, 30)}
    assert verdict(msg, NOW)[0] == "in-flight"
    assert verdict(msg, NOW, stuck_after=15)[0] == "stuck"
