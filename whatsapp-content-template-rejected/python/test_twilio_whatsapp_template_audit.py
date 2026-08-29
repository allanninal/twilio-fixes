from twilio_whatsapp_template_audit import explain_code, verdict, whatsapp_status

TPL = {"sid": "HX0123456789", "friendly_name": "order_shipped_en"}


def approval(status, reason=""):
    return {"whatsapp": {"type": "whatsapp", "status": status,
                         "rejection_reason": reason}}


def test_rejected_carries_the_reason_meta_gave():
    state, detail = verdict(TPL, approval("rejected", "variable at start of body"))
    assert state == "rejected"
    assert "variable at start of body" in detail
    assert "63040" in detail


def test_paused_and_disabled_are_different_repairs():
    paused, pdetail = verdict(TPL, approval("paused"))
    disabled, ddetail = verdict(TPL, approval("disabled"))
    assert (paused, disabled) == ("paused", "disabled")
    assert "lifts on its own" in pdetail
    assert "terminal" in ddetail


def test_no_approval_request_is_unsubmitted_not_rejected():
    # 404 from ApprovalRequests: nobody ever submitted it.
    state, detail = verdict(TPL, None)
    assert state == "unsubmitted"
    assert "63016" in detail


def test_an_approved_template_on_an_account_logging_63016_is_a_code_bug():
    state, detail = verdict(TPL, approval("approved"), {63016: 84})
    assert state == "approved-but-freeform"
    assert "code fix, not a resubmission" in detail


def test_a_clean_approved_template_is_the_only_healthy_state():
    assert verdict(TPL, approval("approved"))[0] == "approved"
    assert verdict(TPL, approval("APPROVED"))[0] == "approved"


def test_blocking_counts_are_labelled_as_context_not_attribution():
    state, detail = verdict(TPL, approval("rejected"), {63040: 3, 63041: 2})
    assert state == "rejected"
    assert "5 blocked-template error(s)" in detail
    assert "context rather than attribution" in detail


def test_status_and_codes_are_read_defensively():
    assert whatsapp_status({}) == ("unsubmitted", "")
    assert whatsapp_status({"whatsapp": {"status": "Pending"}})[0] == "pending"
    assert verdict(TPL, {"whatsapp": {"status": "in_appeal"}})[0] == "unknown-status"
    assert explain_code(63042) == "template disabled"
    assert "unrecognised" in explain_code(12345)
