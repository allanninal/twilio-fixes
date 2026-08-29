from twilio_api_version_audit import account_verdict, is_routed, verdict


def make(**kw):
    number = {"sid": "PN01", "phone_number": "+15005550006",
              "api_version": "2010-04-01", "voice_url": "https://app.example.com/voice"}
    number.update(kw)
    return number


def test_a_number_on_the_current_version_is_current():
    state, detail = verdict(make())
    assert state == "current"
    assert "2010-04-01" in detail


def test_a_2008_pin_with_a_live_handler_is_serving_the_old_schema_now():
    state, detail = verdict(make(api_version="2008-08-01"))
    assert state == "legacy-live"
    assert "absent" in detail


def test_a_2008_pin_with_no_handler_is_a_separate_and_quieter_finding():
    state, detail = verdict(make(api_version="2008-08-01", voice_url=""))
    assert state == "legacy-idle"
    assert "day this number is used" in detail


def test_an_application_sid_alone_still_counts_as_routed():
    assert is_routed({"voice_application_sid": "AP0123456789"}) is True
    assert is_routed({"voice_url": "", "sms_url": None}) is False


def test_a_missing_api_version_is_reported_rather_than_assumed_current():
    state, detail = verdict(make(api_version=None))
    assert state == "unread"
    assert "assuming" in detail


def test_an_unexpected_version_is_never_folded_into_either_bucket():
    state, detail = verdict(make(api_version="2015-01-01"))
    assert state == "unread"
    assert "2015-01-01" in detail


def test_the_account_default_is_its_own_finding_with_its_own_repair():
    state, detail = account_verdict({"api_version": "2008-08-01"})
    assert state == "legacy-default"
    assert "bought from here on" in detail


def test_a_current_account_default_means_new_numbers_arrive_correct():
    assert account_verdict({"api_version": "2010-04-01"})[0] == "current"
    assert account_verdict({})[0] == "unread"
