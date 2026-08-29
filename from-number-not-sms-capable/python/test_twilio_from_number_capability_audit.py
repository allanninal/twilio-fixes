from twilio_from_number_capability_audit import is_e164, verdict

ACCOUNT = "AC11111111111111111111111111111111"
SUB = "AC22222222222222222222222222222222"


def number(sms=True, mms=True, voice=True, account=ACCOUNT):
    return {"phone_number": "+15550001111", "account_sid": account,
            "capabilities": {"sms": sms, "mms": mms, "voice": voice}}


def test_e164_is_checked_the_way_twilio_checks_it():
    assert is_e164("+15550001111")
    assert not is_e164("(555) 010-1234")
    assert not is_e164("15550001111")
    assert not is_e164("+0123456789")
    assert not is_e164(None)


def test_national_format_is_named_rather_than_blamed_on_ownership():
    state, detail = verdict("(555) 010-1234", [], ACCOUNT)
    assert state == "not-e164"
    assert "21606" in detail


def test_a_voice_only_number_is_the_capability_case():
    state, detail = verdict("+15550001111", [number(sms=False, mms=False)], ACCOUNT)
    assert state == "voice-only"
    assert "capabilities.sms is false" in detail
    assert "voice is true" in detail


def test_a_number_on_another_subaccount_is_not_a_capability_problem():
    # Perfect capabilities, still 21606. Reporting this as voice-only sends
    # somebody to buy a number they already own.
    state, detail = verdict("+15550001111", [number(account=SUB)], ACCOUNT)
    assert state == "wrong-account"
    assert SUB in detail and ACCOUNT in detail


def test_no_match_at_all_is_its_own_finding():
    state, detail = verdict("+15550001111", [], ACCOUNT)
    assert state == "not-on-account"
    assert "provisioning" in detail


def test_mms_is_only_a_finding_when_media_is_sent():
    assert verdict("+15550001111", [number(mms=False)], ACCOUNT)[0] == "ok"
    state, _ = verdict("+15550001111", [number(mms=False)], ACCOUNT, need_mms=True)
    assert state == "no-mms"


def test_a_record_without_capabilities_is_not_guessed_at():
    state, _ = verdict("+15550001111", [{"account_sid": ACCOUNT}], ACCOUNT)
    assert state == "unresolved"


def test_a_healthy_sender_says_what_it_can_do():
    state, detail = verdict("+15550001111", [number()], ACCOUNT)
    assert state == "ok"
    assert "sms and mms" in detail
