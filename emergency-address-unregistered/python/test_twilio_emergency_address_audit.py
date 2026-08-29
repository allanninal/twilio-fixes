from twilio_emergency_address_audit import in_scope, verdict


def us_number(**over):
    n = {"phone_number": "+12025550123", "capabilities": {"voice": True, "sms": True},
         "emergency_address_sid": None, "emergency_address_status": "unregistered",
         "emergency_status": "Active", "sid": "PN1"}
    n.update(over)
    return n


def test_number_with_no_address_is_unregistered():
    state, detail = verdict(us_number())
    assert state == "unregistered"
    assert "national emergency call centre" in detail


def test_rejected_registration_is_not_the_same_as_no_address():
    # The SID is populated, so a check that reads only the SID calls this fixed.
    state, detail = verdict(us_number(emergency_address_sid="AD1",
                                      emergency_address_status="registration-failure"))
    assert state == "registration-failed"
    assert "visual check" in detail


def test_pending_registration_is_still_exposed():
    state, _ = verdict(us_number(emergency_address_sid="AD1",
                                 emergency_address_status="pending-registration"))
    assert state == "pending"


def test_registered_address_with_emergency_calling_switched_off():
    state, detail = verdict(us_number(emergency_address_sid="AD1",
                                      emergency_address_status="registered",
                                      emergency_status="Inactive"))
    assert state == "disabled"
    assert "buys nothing" in detail


def test_registered_number_passes():
    state, _ = verdict(us_number(emergency_address_sid="AD1",
                                 emergency_address_status="registered"))
    assert state == "registered"


def test_non_north_american_number_is_out_of_scope_not_a_finding():
    state, detail = verdict(us_number(phone_number="+441632960000"))
    assert state == "out-of-scope"
    assert "does not apply" in detail


def test_sms_only_number_cannot_dial_911():
    state, _ = verdict(us_number(capabilities={"voice": False, "sms": True}))
    assert state == "out-of-scope"
    assert not in_scope(us_number(capabilities={"sms": True}))
