from twilio_sip_domain_auth_audit import auth_modes, verdict

ROUTED = {"auth_type": "CREDENTIAL_LIST",
          "voice_url": "https://app.example.com/voice",
          "voice_fallback_url": "https://app.example.com/fallback"}


def test_empty_auth_type_is_inert():
    state, detail = verdict({"auth_type": "",
                             "voice_url": "https://app.example.com/voice"})
    assert state == "inert"
    assert "cannot receive any traffic" in detail


def test_missing_auth_type_reads_the_same_as_an_empty_one():
    assert verdict({"voice_url": "https://app.example.com/voice"})[0] == "inert"
    assert verdict({"auth_type": None})[0] == "inert"


def test_both_modes_comma_separated_are_parsed_as_two():
    # The reason auth_type is split rather than compared as a string.
    assert auth_modes({"auth_type": "ip_acl, CREDENTIAL_LIST"}) == \
        ["IP_ACL", "CREDENTIAL_LIST"]


def test_declared_but_nothing_mapped_is_auth_unmapped():
    state, _ = verdict(ROUTED, {"credential_list": 0, "ip_acl": 0})
    assert state == "auth-unmapped"


def test_not_checking_mappings_is_not_the_same_as_nothing_mapped():
    assert verdict(ROUTED)[0] == "routed"


def test_one_of_two_modes_unmapped_is_the_intermittent_case():
    domain = dict(ROUTED, auth_type="IP_ACL,CREDENTIAL_LIST")
    state, detail = verdict(domain, {"credential_list": 1, "ip_acl": 0})
    assert state == "partial-auth"
    assert "IP_ACL" in detail


def test_authenticated_domain_with_no_voice_url_is_no_handler():
    domain = dict(ROUTED, voice_url="")
    assert verdict(domain, {"credential_list": 1, "ip_acl": 0})[0] == "no-handler"


def test_missing_fallback_is_reported_after_the_bigger_failures():
    domain = dict(ROUTED, voice_fallback_url="")
    state, detail = verdict(domain, {"credential_list": 1, "ip_acl": 0})
    assert state == "no-fallback"
    assert "non-2xx" in detail
