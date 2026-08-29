from twilio_sole_prop_pool_audit import verdict

SOLE_PROP = {"brand_type": "SOLE_PROPRIETOR", "status": "APPROVED"}
STANDARD = {"brand_type": "STANDARD", "status": "APPROVED"}


def test_three_numbers_leaves_two_permanently_unregistered():
    state, detail = verdict(SOLE_PROP, 3, "VERIFIED")
    assert state == "overfilled"
    assert "2 of them" in detail
    assert "at random" in detail


def test_one_number_on_a_verified_campaign_is_the_supported_shape():
    assert verdict(SOLE_PROP, 1, "VERIFIED")[0] == "registered"


def test_an_empty_pool_is_the_opposite_mistake():
    state, detail = verdict(SOLE_PROP, 0, "VERIFIED")
    assert state == "empty-pool"
    assert "consistently" in detail


def test_one_number_on_an_unapproved_campaign_is_the_review_clock():
    state, detail = verdict(SOLE_PROP, 1, "IN_PROGRESS")
    assert state == "single-not-verified"
    assert "not the sender limit" in detail


def test_a_standard_brand_is_not_capped_by_pool_size():
    state, _ = verdict(STANDARD, 12, "VERIFIED")
    assert state == "not-sole-prop"


def test_an_unread_brand_is_never_reported_as_compliant():
    # Following brand_registration_sid can fail. Guessing SOLE_PROPRIETOR would
    # invent findings; guessing STANDARD would hide them.
    assert verdict(None, 4, "VERIFIED")[0] == "brand-unread"


def test_an_unread_pool_is_reported_as_such():
    assert verdict(SOLE_PROP, None, "VERIFIED")[0] == "pool-unread"


def test_an_unset_brand_type_is_not_assumed_to_be_sole_prop():
    state, detail = verdict({"status": "APPROVED"}, 5)
    assert state == "not-sole-prop"
    assert "unset" in detail
