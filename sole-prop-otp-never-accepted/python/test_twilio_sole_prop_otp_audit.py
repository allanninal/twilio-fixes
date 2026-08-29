import datetime

from twilio_sole_prop_otp_audit import age_hours, verdict

OTPS = {"brand_registration_otps": "https://messaging.twilio.com/v1/a2p/"
                                   "BrandRegistrations/BN01/SmsOtp"}
WAITING = {"brand_type": "SOLE_PROPRIETOR", "status": "PENDING",
           "identity_status": "SELF_DECLARED", "links": OTPS}
NOW = datetime.datetime(2026, 8, 30, tzinfo=datetime.timezone.utc)


def test_inside_the_window_the_passcode_is_still_in_flight():
    state, detail = verdict(WAITING, 6.0)
    assert state == "otp-outstanding"
    assert "18 hours left" in detail


def test_past_the_window_the_passcode_has_expired_unanswered():
    state, detail = verdict(WAITING, 40.0)
    assert state == "otp-lapsed"
    assert "reply window has closed" in detail


def test_approved_status_does_not_rescue_an_unverified_identity():
    # This is the state that reaches production: somebody reads status, sees
    # APPROVED, and enables US sending on a brand that cannot register numbers.
    state, detail = verdict(dict(WAITING, status="APPROVED"), 72.0)
    assert state == "otp-lapsed"
    assert "status reads APPROVED" in detail


def test_vetted_verified_counts_as_answered():
    assert verdict(dict(WAITING, identity_status="VETTED_VERIFIED"), 500.0)[0] == "verified"


def test_missing_otp_subresource_is_not_an_unanswered_text():
    brand = dict(WAITING, links={})
    state, detail = verdict(brand, 200.0)
    assert state == "no-otp-subresource"
    assert "submission problem" in detail


def test_a_failed_brand_is_read_before_the_passcode():
    assert verdict(dict(WAITING, status="FAILED"), 200.0)[0] == "brand-failed"


def test_standard_brands_are_left_alone():
    state, detail = verdict({"brand_type": "STANDARD", "identity_status": "UNVERIFIED"}, 999.0)
    assert state == "not-sole-prop"
    assert "no passcode is ever sent" in detail


def test_an_unreadable_date_is_reported_rather_than_guessed():
    assert verdict(WAITING, None)[0] == "age-unknown"
    assert age_hours("not a date", NOW) is None
    assert round(age_hours("2026-08-29T00:00:00Z", NOW)) == 24
