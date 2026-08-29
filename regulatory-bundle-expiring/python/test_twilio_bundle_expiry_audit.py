import datetime

from twilio_bundle_expiry_audit import callback_note, parse_date, verdict

NOW = datetime.datetime(2026, 8, 30, tzinfo=datetime.timezone.utc)


def make(**kw):
    bundle = {"sid": "BU00000000000000000000000000000001",
              "friendly_name": "DE local address",
              "iso_country": "DE",
              "number_type": "local",
              "status": "twilio-approved",
              "valid_until": "2027-06-01T00:00:00Z",
              "status_callback": "https://ops.example.com/bundle"}
    bundle.update(kw)
    return bundle


def test_iso_dates_from_the_numbers_v2_api_parse_with_a_trailing_z():
    assert parse_date("2027-06-01T00:00:00Z") == \
        datetime.datetime(2027, 6, 1, tzinfo=datetime.timezone.utc)


def test_an_approved_bundle_far_from_its_date_is_current():
    state, detail = verdict(make(), NOW, horizon_days=60)
    assert state == "current"
    assert "275 day(s)" in detail


def test_an_approved_bundle_inside_the_horizon_is_the_warning():
    state, detail = verdict(make(valid_until="2026-09-15T00:00:00Z"), NOW,
                            horizon_days=60)
    assert state == "expiring"
    assert "16 day(s)" in detail


def test_the_horizon_is_the_thing_that_decides():
    bundle = make(valid_until="2026-10-20T00:00:00Z")
    assert verdict(bundle, NOW, horizon_days=30)[0] == "current"
    assert verdict(bundle, NOW, horizon_days=60)[0] == "expiring"


def test_a_date_already_past_is_an_incident_not_a_warning():
    state, detail = verdict(make(valid_until="2026-08-01T00:00:00Z"), NOW)
    assert state == "expired"
    assert "29 day(s) ago" in detail


def test_the_aftermath_reads_as_rejected_rather_than_as_expired():
    state, detail = verdict(make(status="twilio-rejected",
                                 valid_until="2026-07-01T00:00:00Z"), NOW)
    assert state == "rejected"
    assert "non-compliant today" in detail


def test_a_null_valid_until_is_healthy_and_must_not_be_read_as_expired():
    state, detail = verdict(make(valid_until=None), NOW)
    assert state == "no-expiry"
    assert "re-attestation" in detail


def test_a_bundle_that_was_never_approved_is_somebody_else_s_note():
    state, _ = verdict(make(status="pending-review", valid_until=None), NOW)
    assert state == "not-approved"


def test_a_missing_status_callback_is_reported_alongside_the_date():
    assert callback_note(make(status_callback="")) is not None
    assert callback_note(make()) is None
