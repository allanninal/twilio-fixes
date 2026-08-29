from twilio_outbound_disabled_audit import attribute, verdict


def test_attribute_buckets_by_account_sid_and_skips_inbound():
    rows = [
        {"direction": "outbound-api", "account_sid": "ACchild",
         "error_code": "30037", "sid": "SM1"},
        {"direction": "outbound-api", "account_sid": "ACchild",
         "error_code": 30037, "sid": "SM2"},
        {"direction": "outbound-api", "account_sid": "ACparent",
         "error_code": None, "sid": "SM3"},
        {"direction": "inbound", "account_sid": "ACchild",
         "error_code": 30037, "sid": "SM4"},
    ]
    buckets = attribute(rows)
    assert buckets["ACchild"]["total"] == 2
    assert buckets["ACchild"]["blocked"] == 2
    assert buckets["ACparent"]["blocked"] == 0
    assert buckets["ACchild"]["sids"] == ["SM1", "SM2"]


def test_other_error_codes_are_not_counted():
    rows = [{"direction": "outbound-api", "account_sid": "AC1",
             "error_code": 30007, "sid": "SM1"}]
    assert attribute(rows)["AC1"]["blocked"] == 0


def test_suspended_account_explains_every_failure():
    state, detail = verdict({"status": "suspended", "type": "Full"},
                            {"total": 120, "blocked": 120})
    assert state == "suspended"
    assert "every sender" in detail


def test_closed_account_is_permanent():
    state, detail = verdict({"status": "closed", "type": "Full"},
                            {"total": 0, "blocked": 0})
    assert state == "closed"
    assert "not reversible" in detail


def test_active_account_with_30037_means_messaging_is_disabled():
    state, detail = verdict({"status": "active", "type": "Full"},
                            {"total": 90, "blocked": 90})
    assert state == "messaging-disabled"
    assert "disabled on this account" in detail


def test_active_account_with_no_rejections_is_fine():
    state, _ = verdict({"status": "active", "type": "Full"},
                       {"total": 90, "blocked": 0})
    assert state == "active"


def test_failures_on_a_sid_outside_the_account_list_are_a_credential_problem():
    state, detail = verdict(None, {"total": 40, "blocked": 40})
    assert state == "unknown-account"
    assert "Account SID" in detail
