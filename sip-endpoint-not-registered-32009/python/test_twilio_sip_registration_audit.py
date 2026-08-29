from twilio_sip_registration_audit import sip_target, verdict

DOMAINS = {
    "acme.sip.twilio.com": {"sip_registration": True,
                            "usernames": ["Reception", "warehouse"]},
    "calls-only.sip.twilio.com": {"sip_registration": False, "usernames": []},
    "open.sip.twilio.com": {"sip_registration": True, "usernames": []},
}


def test_plain_uri_splits_into_user_and_domain():
    assert sip_target("sip:warehouse@acme.sip.twilio.com") == \
        ("warehouse", "acme.sip.twilio.com")


def test_domain_is_lowercased_and_the_user_is_not():
    # Folding the user would destroy the only evidence the case-mismatch state
    # has to work with, so the asymmetry is deliberate and pinned here.
    assert sip_target("SIP:Reception@ACME.sip.twilio.com") == \
        ("Reception", "acme.sip.twilio.com")


def test_port_parameters_display_name_and_sips_all_reduce_the_same():
    assert sip_target("sips:warehouse@acme.sip.twilio.com:5061") == \
        ("warehouse", "acme.sip.twilio.com")
    assert sip_target("sip:warehouse@acme.sip.twilio.com;transport=tls") == \
        ("warehouse", "acme.sip.twilio.com")
    assert sip_target('"Front desk" <sip:warehouse@acme.sip.twilio.com>') == \
        ("warehouse", "acme.sip.twilio.com")


def test_a_tel_uri_or_a_bare_number_is_not_a_sip_target():
    assert sip_target("+15005550006") == ("", "")
    assert sip_target("sip:acme.sip.twilio.com") == ("", "")
    assert sip_target(None) == ("", "")


def test_missing_destination_is_unresolved_rather_than_a_guess():
    state, _ = verdict(("", ""), DOMAINS)
    assert state == "unresolved"


def test_domain_not_on_the_account_is_its_own_state():
    state, _ = verdict(("warehouse", "other.sip.twilio.com"), DOMAINS)
    assert state == "unknown-domain"


def test_registration_disabled_is_permanent_not_transient():
    state, detail = verdict(("warehouse", "calls-only.sip.twilio.com"), DOMAINS)
    assert state == "registration-off"
    assert "never will" in detail


def test_registration_enabled_with_nothing_mapped():
    state, detail = verdict(("warehouse", "open.sip.twilio.com"), DOMAINS)
    assert state == "no-credentials"
    assert "Auth/Registrations" in detail


def test_exact_match_means_the_endpoint_was_merely_offline():
    state, detail = verdict(("warehouse", "acme.sip.twilio.com"), DOMAINS)
    assert state == "offline"
    assert "REGISTER refresh" in detail


def test_case_mismatch_is_reported_separately_and_names_both_strings():
    # Reported as unknown-user, this sends someone to create a credential that
    # already exists. It is the whole reason the parser preserves case.
    state, detail = verdict(("reception", "acme.sip.twilio.com"), DOMAINS)
    assert state == "case-mismatch"
    assert "Reception" in detail
    assert "reception" in detail


def test_username_nobody_ever_created_is_unknown_user():
    state, detail = verdict(("nightshift", "acme.sip.twilio.com"), DOMAINS)
    assert state == "unknown-user"
    assert "2 registerable" in detail
