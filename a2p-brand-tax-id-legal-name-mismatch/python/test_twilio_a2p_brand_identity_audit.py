from twilio_a2p_brand_identity_audit import edit_targets, error_code, verdict

FAILED = {"sid": "BN0123456789", "status": "FAILED"}


def test_30799_is_reported_as_an_identity_mismatch():
    state, detail = verdict(dict(FAILED, errors=[{"code": "30799"}]))
    assert state == "identity-mismatch"
    assert "Customer Profile" in detail


def test_the_brand_resource_spells_the_key_code_not_error_code():
    # The campaign resource says error_code. A classifier that reads only one of
    # them reports every brand rejection as unrecognised.
    assert error_code({"code": 30799}) == "30799"
    assert error_code({"error_code": 30799}) == "30799"


def test_named_fields_win_over_the_identity_triple():
    errors = [{"code": "30799", "fields": ["business_registration_identifier"]}]
    assert edit_targets(errors) == ["business_registration_identifier"]


def test_a_30799_with_no_fields_still_says_where_to_look():
    assert edit_targets([{"code": "30799"}]) == [
        "legal company name", "registered business address",
        "business_registration_identifier"]


def test_other_codes_contribute_no_edit_targets():
    assert edit_targets([{"code": "30898"}]) == []


def test_a_brand_failed_on_another_code_is_not_an_identity_mismatch():
    state, detail = verdict(dict(FAILED, errors=[{"code": "30898"}]))
    assert state == "failed-elsewhere"
    assert "30898" in detail


def test_approved_but_self_declared_is_reported():
    state, detail = verdict({"sid": "BN1", "status": "APPROVED",
                             "identity_status": "SELF_DECLARED"})
    assert state == "approved-unverified-identity"
    assert "30799" in detail


def test_a_vetted_brand_is_clean():
    state, _ = verdict({"sid": "BN1", "status": "APPROVED",
                        "identity_status": "VETTED_VERIFIED"})
    assert state == "approved"


def test_suspension_is_not_an_identity_problem():
    state, detail = verdict({"sid": "BN1", "status": "SUSPENDED"})
    assert state == "suspended"
    assert "compliance decision" in detail
