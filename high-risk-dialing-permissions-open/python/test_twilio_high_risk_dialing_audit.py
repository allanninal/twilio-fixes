from twilio_high_risk_dialing_audit import countries_for, money, prefix_index, verdict


def open_country(iso, low=True, special=False, fraud=False):
    return {"iso_code": iso, "country_codes": ["500"],
            "low_risk_numbers_enabled": low,
            "high_risk_special_numbers_enabled": special,
            "high_risk_tollfraud_numbers_enabled": fraud}


def test_both_classes_disabled_is_closed():
    assert verdict(open_country("LV"))[0] == "closed"


def test_low_risk_off_with_high_risk_on_is_the_telling_combination():
    state, detail = verdict(open_country("LV", low=False, fraud=True),
                            served=["US"])
    assert state == "premium-only"
    assert "Nobody configures that deliberately" in detail


def test_open_range_with_traffic_is_an_incident_not_an_exposure():
    state, detail = verdict(open_country("LV", special=True), served=["US"],
                            attempts=41, spend=1830.5)
    assert state == "open-and-dialled"
    assert "1830.50" in detail


def test_open_range_outside_the_served_set_is_carried_for_no_return():
    assert verdict(open_country("LV", fraud=True), served=["US", "GB"])[0] == \
        "open-unused"


def test_open_range_in_a_served_country_is_still_reported():
    state, _ = verdict(open_country("GB", special=True), served=["us", "gb"])
    assert state == "open-in-market"


def test_served_codes_are_compared_case_insensitively():
    assert verdict(open_country("GB", fraud=True), served=["gb"])[0] == "open-in-market"


def test_price_strings_are_negative_and_report_as_spend():
    assert money("-0.0850") == 0.085
    assert money(None) == 0.0
    assert money("not a price") == 0.0


def test_prefix_join_keeps_shared_codes_as_a_group():
    index = prefix_index([open_country("A"), open_country("B")])
    assert countries_for("+5005550100", index) == ["A", "B"]
