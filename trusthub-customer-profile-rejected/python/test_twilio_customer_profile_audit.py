import datetime

from twilio_customer_profile_audit import (dependents, error_lines, verdict)

NOW = datetime.datetime(2026, 8, 30, tzinfo=datetime.timezone.utc)

PROFILE_SID = "BU00000000000000000000000000000003"

BRANDS = [
    {"sid": "BN00000000000000000000000000000001",
     "status": "FAILED",
     "customer_profile_bundle_sid": PROFILE_SID},
    {"sid": "BN00000000000000000000000000000002",
     "status": "APPROVED",
     "customer_profile_bundle_sid": "BU99999999999999999999999999999999"},
]

VERIFICATIONS = [
    {"sid": "HH00000000000000000000000000000001",
     "status": "TWILIO_REJECTED",
     "customer_profile_sid": PROFILE_SID},
    {"sid": "HH00000000000000000000000000000002",
     "status": "TWILIO_APPROVED",
     "customer_profile_sid": "BU99999999999999999999999999999999"},
]


def make(**kw):
    profile = {"sid": PROFILE_SID,
               "friendly_name": "Example Ltd primary",
               "status": "twilio-rejected",
               "valid_until": None,
               "policy_sid": "RN00000000000000000000000000000001",
               "errors": []}
    profile.update(kw)
    return profile


def test_a_rejected_profile_points_at_itself_rather_than_downstream():
    state, detail = verdict(make(), NOW)
    assert state == "rejected"
    assert "not on the brand" in detail


def test_draft_blocks_the_same_products_and_has_no_errors_to_read():
    state, detail = verdict(make(status="draft"), NOW)
    assert state == "draft"
    assert "never submitted" in detail


def test_review_states_are_a_reason_to_hold_not_to_retry():
    state, detail = verdict(make(status="in-review"), NOW)
    assert state == "in-review"
    assert "hold them" in detail
    assert verdict(make(status="pending-review"), NOW)[0] == "in-review"


def test_an_approved_profile_past_valid_until_is_not_approved():
    state, detail = verdict(
        make(status="twilio-approved", valid_until="2026-07-01T00:00:00Z"), NOW)
    assert state == "expired"
    assert "2026-07-01" in detail


def test_an_approved_profile_in_date_is_the_only_healthy_state():
    state, _ = verdict(
        make(status="twilio-approved", valid_until="2027-07-01T00:00:00Z"), NOW)
    assert state == "approved"
    state, _ = verdict(make(status="twilio-approved", valid_until=None), NOW)
    assert state == "approved"


def test_dependents_match_both_spellings_of_the_same_reference():
    found = dependents(PROFILE_SID, BRANDS, VERIFICATIONS)
    assert len(found) == 2
    assert "brand BN00000000000000000000000000000001 (FAILED)" in found
    assert any(f.startswith("toll-free verification HH00") for f in found)


def test_objects_on_another_profile_are_not_claimed():
    assert dependents("BU00000000000000000000000000000009",
                      BRANDS, VERIFICATIONS) == []
    assert dependents("", BRANDS, VERIFICATIONS) == []
    assert dependents(PROFILE_SID, None, None) == []


def test_errors_render_whether_they_are_objects_or_strings():
    lines = error_lines(make(errors=[{"code": 21212,
                                      "description": "business name mismatch"},
                                     "legacy string entry"]))
    assert lines[0] == "21212: business name mismatch"
    assert lines[1] == "legacy string entry"
    assert error_lines(make()) == []
