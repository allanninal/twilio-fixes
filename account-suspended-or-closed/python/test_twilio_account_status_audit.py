from twilio_account_status_audit import scope, suspended_rows, verdict


def test_suspended_status_is_the_finding():
    state, detail = verdict({"sid": "AC1", "status": "suspended"})
    assert state == "suspended"
    assert "20005" in detail


def test_closed_outranks_suspended_and_says_it_is_terminal():
    state, detail = verdict({"sid": "AC1", "status": "closed"})
    assert state == "closed"
    assert "terminal" in detail


def test_status_is_compared_case_insensitively():
    assert verdict({"sid": "AC1", "status": "Suspended"})[0] == "suspended"


def test_an_unfamiliar_status_is_not_read_as_healthy():
    state, _ = verdict({"sid": "AC1", "status": "pending-closure"})
    assert state == "not-active"


def test_a_missing_status_field_is_not_read_as_healthy():
    assert verdict({"sid": "AC1"})[0] == "unknown"


def test_active_with_30002_in_the_window_is_still_a_finding():
    state, detail = verdict({"sid": "AC1", "status": "active"}, failed=41, days=7)
    assert state == "recently-suspended"
    assert "41" in detail


def test_active_and_clean_passes():
    assert verdict({"sid": "AC1", "status": "active"}, failed=0)[0] == "active"


def test_owner_account_sid_separates_a_parent_from_a_tenant():
    assert scope({"sid": "AC1", "owner_account_sid": "AC1"}) == "account"
    assert scope({"sid": "AC2", "owner_account_sid": "AC1"}) == "subaccount"


def test_suspended_rows_filters_by_error_code_and_sorts_oldest_first():
    rows = suspended_rows([
        {"error_code": 30002, "date_sent": "2024-05-02"},
        {"error_code": 30007, "date_sent": "2024-05-01"},
        {"error_code": "30002", "date_sent": "2024-05-01"},
        {"error_code": None, "date_sent": "2024-05-03"},
    ])
    assert [r["date_sent"] for r in rows] == ["2024-05-01", "2024-05-02"]
