from twilio_sync_webhook_audit import alert_counts, verdict

URL = "https://app.example.com/sync"


def service(**kw):
    base = {"sid": "IS1", "friendly_name": "live", "webhook_url": URL,
            "webhooks_from_rest_enabled": True}
    base.update(kw)
    return base


def test_rest_writes_decide_whether_the_flag_is_a_fault():
    svc = service(webhooks_from_rest_enabled=False)
    assert verdict(svc, rest_writes=False)[0] == "rest-disabled"
    state, detail = verdict(svc, rest_writes=True)
    assert state == "rest-silent"
    assert "No error is raised" in detail


def test_an_empty_webhook_url_is_the_first_thing_reported():
    state, detail = verdict(service(webhook_url="", webhooks_from_rest_enabled=False))
    assert state == "no-url"
    assert "54051" in detail


def test_plain_http_is_rejected_and_insecure():
    state, detail = verdict(service(webhook_url="http://app.example.com/sync"))
    assert state == "insecure"
    assert "in the clear" in detail


def test_a_url_with_no_scheme_is_not_absolute():
    assert verdict(service(webhook_url="app.example.com/sync"))[0] == "not-absolute"


def test_alerts_against_a_well_formed_url_mean_unreachable():
    state, detail = verdict(service(), alerts=12)
    assert state == "unreachable"
    assert "12 alert(s)" in detail


def test_a_healthy_service_is_ok():
    assert verdict(service(), rest_writes=True)[0] == "ok"


def test_alert_counts_coerce_the_code_and_key_on_the_resource():
    alerts = [{"error_code": "54051", "resource_sid": "IS1"},
              {"error_code": 54051, "resource_sid": "IS1"},
              {"error_code": 54051, "resource_sid": "IS2"},
              {"error_code": 11200, "resource_sid": "IS1"},
              {"error_code": None, "resource_sid": "IS1"}]
    assert alert_counts(alerts) == {"IS1": 2, "IS2": 1}


def test_an_alert_with_no_resource_is_still_counted():
    assert alert_counts([{"error_code": 54051}]) == {"(unattributed)": 1}
