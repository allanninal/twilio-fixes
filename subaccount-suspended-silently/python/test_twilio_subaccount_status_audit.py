from twilio_subaccount_status_audit import summary, verdict

PARENT = "ACparent0000000000000000000000000"


def make(**kw):
    row = {"sid": "ACtenant000000000000000000000001",
           "owner_account_sid": PARENT,
           "friendly_name": "Acme Corp (prod)",
           "status": "active",
           "type": "Full"}
    row.update(kw)
    return row


def test_the_parents_own_row_is_not_a_tenant():
    state, detail = verdict(make(sid=PARENT, owner_account_sid=PARENT), PARENT)
    assert state == "parent"
    assert "owner" in detail


def test_a_suspended_tenant_is_the_finding():
    state, detail = verdict(make(status="suspended"), PARENT)
    assert state == "suspended"
    assert "20005" in detail


def test_a_closed_tenant_is_reported_as_terminal():
    state, detail = verdict(make(status="closed"), PARENT)
    assert state == "closed"
    assert "cannot be reopened" in detail


def test_a_row_owned_by_another_parent_is_not_ours_to_fix():
    state, _ = verdict(make(owner_account_sid="ACsomeoneelse"), PARENT)
    assert state == "foreign"


def test_an_active_trial_subaccount_is_still_worth_saying():
    state, _ = verdict(make(type="Trial"), PARENT)
    assert state == "trial"


def test_status_casing_from_the_api_does_not_change_the_answer():
    assert verdict(make(status="SUSPENDED"), PARENT)[0] == "suspended"


def test_an_unrecognised_status_is_not_quietly_called_active():
    state, _ = verdict(make(status="pending"), PARENT)
    assert state == "unknown"


def test_summary_reports_the_recoverable_failure_first():
    state, detail = summary(["parent", "active", "suspended", "closed"])
    assert state == "suspended"
    assert "one write" in detail


def test_summary_keeps_closures_separate_from_suspensions():
    state, detail = summary(["parent", "active", "closed"])
    assert state == "closed"
    assert "permanent" in detail


def test_a_parent_with_no_subaccounts_has_nothing_to_watch():
    assert summary(["parent"])[0] == "single"


def test_all_active_tenants_are_clean():
    state, detail = summary(["parent", "active", "active", "trial"])
    assert state == "clean"
    assert "3 subaccount(s)" in detail
