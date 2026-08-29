from twilio_bundle_rejection_audit import notification_gap, verdict


def make(**kw):
    bundle = {"sid": "BU00000000000000000000000000000001",
              "friendly_name": "DE local business",
              "iso_country": "DE",
              "number_type": "local",
              "status": "twilio-rejected",
              "email": "compliance@example.com",
              "status_callback": "https://ops.example.com/bundle"}
    bundle.update(kw)
    return bundle


def test_a_rejected_bundle_names_the_purchase_it_blocks():
    state, detail = verdict(make())
    assert state == "rejected"
    assert "No number can be bought" in detail


def test_draft_is_not_folded_into_rejected():
    state, detail = verdict(make(status="draft"))
    assert state == "draft"
    assert "never submitted" in detail
    assert "submitting, not correcting" in detail


def test_both_review_states_read_as_waiting():
    assert verdict(make(status="pending-review"))[0] == "in-review"
    assert verdict(make(status="in-review"))[0] == "in-review"


def test_approved_defers_the_expiry_question_rather_than_answering_it():
    state, detail = verdict(make(status="twilio-approved"))
    assert state == "approved"
    assert "valid_until" in detail


def test_a_status_the_script_has_never_seen_is_not_healthy():
    state, detail = verdict(make(status="provisionally-approved"))
    assert state == "unknown"
    assert "provisionally-approved" in detail
    state, _ = verdict(make(status=None))
    assert state == "unknown"


def test_valid_until_is_deliberately_not_consulted():
    # A rejected bundle with a date years away is still rejected. The date is
    # the subject of a different check, and reading it here would soften a
    # finding that is not soft.
    state, _ = verdict(make(valid_until="2030-01-01T00:00:00Z"))
    assert state == "rejected"


def test_notification_gap_needs_both_channels_empty():
    assert notification_gap(make()) is None
    assert notification_gap(make(status_callback="")) is None
    assert notification_gap(make(email="")) is None
    assert notification_gap(make(email="", status_callback="")) is not None
    assert notification_gap(make(email="  ", status_callback=None)) is not None
