from twilio_a2p_brand_suspension_audit import attached, verdict

BRAND = {"sid": "BN0123456789", "status": "SUSPENDED"}
OK_BRAND = {"sid": "BN0123456789", "status": "APPROVED"}


def campaign(status, brand_sid="BN0123456789", sid="QE1"):
    return {"sid": sid, "campaign_status": status,
            "brand_registration_sid": brand_sid}


def test_suspended_brand_over_suspended_campaigns_is_a_cascade():
    state, detail = verdict(BRAND, [campaign("SUSPENDED")])
    assert state == "cascade"
    assert "30033" in detail


def test_suspended_brand_with_verified_campaigns_is_still_the_brands_fault():
    # The campaign resource has not caught up. Sends fail anyway, and a check
    # that only looks for suspended campaigns calls this account healthy.
    state, detail = verdict(BRAND, [campaign("VERIFIED")])
    assert state == "cascade-not-yet-visible"
    assert "telling the truth" in detail


def test_a_partly_updated_cascade_says_how_many():
    state, detail = verdict(BRAND, [campaign("SUSPENDED", sid="QE1"),
                                    campaign("VERIFIED", sid="QE2")])
    assert state == "cascade-partial"
    assert "1 of 2" in detail


def test_suspended_campaign_under_a_healthy_brand_is_campaign_level():
    state, detail = verdict(OK_BRAND, [campaign("SUSPENDED")])
    assert state == "campaign-suspended-only"
    assert "errors[]" in detail


def test_a_suspended_brand_with_nothing_attached_is_still_reported():
    assert verdict(BRAND, [])[0] == "brand-suspended-no-campaign"


def test_an_approved_brand_with_verified_campaigns_is_clean():
    assert verdict(OK_BRAND, [campaign("VERIFIED")])[0] == "clean"


def test_a_failed_brand_is_not_a_suspension():
    state, detail = verdict({"sid": "BN1", "status": "FAILED"}, [])
    assert state == "brand-not-usable"
    assert "never came up" in detail


def test_campaigns_are_attributed_by_brand_registration_sid():
    pool = [campaign("SUSPENDED", "BN1", "QE1"), campaign("VERIFIED", "BN2", "QE2")]
    assert [c["sid"] for c in attached(pool, "BN1")] == ["QE1"]


def test_a_blank_brand_sid_attributes_nothing():
    assert attached([campaign("SUSPENDED", "", "QE1")], "") == []
