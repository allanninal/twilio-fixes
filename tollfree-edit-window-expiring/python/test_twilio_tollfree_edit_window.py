import datetime

from twilio_tollfree_edit_window import hours_left, verdict

OPEN = {"sid": "HH01", "status": "TWILIO_REJECTED", "edit_allowed": True,
        "edit_expiration": "2026-09-02T00:00:00Z"}
NOW = datetime.datetime(2026, 8, 30, tzinfo=datetime.timezone.utc)


def test_inside_the_horizon_is_the_finding():
    state, detail = verdict(OPEN, 40.0, horizon_hours=72.0)
    assert state == "closing"
    assert "back of the review queue" in detail


def test_outside_the_horizon_is_not_a_finding_yet():
    assert verdict(OPEN, 200.0, horizon_hours=72.0)[0] == "open"


def test_the_timestamp_wins_over_the_boolean():
    # edit_allowed can still read true after the expiration has passed.
    state, detail = verdict(OPEN, -12.0)
    assert state == "window-lapsed"
    assert "expect the correction to be refused" in detail


def test_edit_allowed_false_has_no_deadline_to_race():
    state, detail = verdict(dict(OPEN, edit_allowed=False), 40.0)
    assert state == "no-edit-window"
    assert "fresh submission is the only path" in detail


def test_an_absent_edit_allowed_is_not_read_as_false():
    rec = {"sid": "HH02", "status": "TWILIO_REJECTED"}
    state, detail = verdict(rec, 40.0)
    assert state == "edit-allowed-unset"
    assert "not the same as false" in detail


def test_an_unparseable_expiration_is_treated_as_urgent():
    state, _ = verdict(dict(OPEN, edit_expiration="soon"), None)
    assert state == "expiration-unreadable"


def test_records_that_were_not_rejected_are_skipped():
    state, _ = verdict({"status": "TWILIO_APPROVED", "edit_allowed": True}, 5.0)
    assert state == "not-rejected"


def test_hours_left_reads_the_trailing_z_timestamp():
    assert round(hours_left("2026-08-31T00:00:00Z", NOW)) == 24
    assert round(hours_left("2026-08-29T00:00:00Z", NOW)) == -24
    assert hours_left("not a date", NOW) is None
