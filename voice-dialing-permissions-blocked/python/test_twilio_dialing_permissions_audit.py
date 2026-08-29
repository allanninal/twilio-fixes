from twilio_dialing_permissions_audit import (countries_for, prefix_index,
                                                 settings_verdict, verdict)

LISTING = [
    {"iso_code": "US", "country_codes": ["1"], "low_risk_numbers_enabled": True},
    {"iso_code": "CA", "country_codes": ["1"], "low_risk_numbers_enabled": True},
    {"iso_code": "GB", "country_codes": ["44"], "low_risk_numbers_enabled": False},
    {"iso_code": "AU", "country_codes": ["61"], "low_risk_numbers_enabled": False},
]


def test_shared_dialling_code_resolves_to_the_whole_group():
    # Picking one member would blame Canada for traffic to the United States.
    assert countries_for("+14155550100", prefix_index(LISTING)) == ["CA", "US"]


def test_longest_prefix_wins():
    index = prefix_index([{"iso_code": "GB", "country_codes": ["44"]},
                          {"iso_code": "XX", "country_codes": ["4470"]}])
    assert countries_for("+447012345678", index) == ["XX"]


def test_destination_outside_every_prefix_resolves_to_nothing():
    assert countries_for("not-a-number", prefix_index(LISTING)) == []


def test_disabled_country_with_refusals_is_an_outage():
    state, detail = verdict(LISTING[2], attempts=40, blocked=12)
    assert state == "blocking-live-traffic"
    assert "21215" in detail


def test_disabled_country_with_traffic_but_no_alerts_is_softer():
    assert verdict(LISTING[2], attempts=40)[0] == "blocking-attempted"


def test_disabled_country_nobody_calls_is_context_not_a_finding():
    state, detail = verdict(LISTING[3])
    assert state == "closed-unused"
    assert "not a finding" in detail


def test_inheritance_off_with_subaccounts_explains_the_regression():
    state, detail = settings_verdict({"dialing_permissions_inheritance": False}, 6)
    assert state == "not-inherited"
    assert "6 subaccount(s)" in detail


def test_inheritance_off_without_subaccounts_is_a_future_problem():
    assert settings_verdict({"dialing_permissions_inheritance": False})[0] == \
        "not-inherited-no-subaccounts"
