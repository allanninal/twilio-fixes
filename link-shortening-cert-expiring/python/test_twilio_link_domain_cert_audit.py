import datetime

from twilio_link_domain_cert_audit import days_left, validation_pending, verdict

CERT = {"date_expires": "2026-10-01T00:00:00Z"}
VALIDATING = dict(CERT, cert_in_validation={"status": "pending"})
VALIDATED = dict(CERT, cert_in_validation={"status": "validated"})
NOW = datetime.datetime(2026, 8, 30, tzinfo=datetime.timezone.utc)


def test_inside_the_renewal_window_is_the_finding():
    state, detail = verdict(CERT, 12.0, window_days=30)
    assert state == "expiring"
    assert "30131" in detail


def test_outside_the_window_is_current():
    assert verdict(CERT, 120.0, window_days=30)[0] == "current"


def test_an_expired_certificate_names_both_failure_codes():
    state, detail = verdict(CERT, -3.0)
    assert state == "expired"
    assert "30120" in detail and "30129" in detail


def test_a_replacement_in_validation_does_not_stop_the_clock():
    # This is the state that reads as handled in a status meeting and is not.
    state, detail = verdict(VALIDATING, 4.0, window_days=30)
    assert state == "expiring-replacement-validating"
    assert "not live yet" in detail


def test_a_stalled_replacement_on_a_healthy_certificate_is_untidy_not_urgent():
    assert verdict(VALIDATING, 200.0)[0] == "validation-pending"


def test_a_validated_replacement_is_not_reported():
    assert verdict(VALIDATED, 200.0)[0] == "current"
    assert validation_pending(VALIDATED) is False


def test_no_certificate_is_reported_as_unknown_rather_than_clean():
    state, detail = verdict(None, None)
    assert state == "no-certificate"
    assert "wrong domain sid" in detail


def test_days_left_reads_the_trailing_z_timestamp():
    assert round(days_left("2026-09-06T00:00:00Z", NOW)) == 7
    assert round(days_left("2026-08-23T00:00:00Z", NOW)) == -7
    assert days_left("not a date", NOW) is None
