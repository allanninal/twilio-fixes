from twilio_conversation_webhook_audit import conversation_sids, verdict

CH = "CH11111111111111111111111111111111"
CH2 = "CH22222222222222222222222222222222"


def alert(code=50369, resource=CH, text=""):
    return {"sid": "NO1", "error_code": code, "resource_sid": resource,
            "alert_text": text, "log_level": "error"}


def hook(target="webhook", **cfg):
    return {"sid": "WH1", "target": target, "configuration": cfg}


def test_error_code_as_a_string_still_matches():
    assert conversation_sids([alert(code="50369")]) == [CH]


def test_other_error_codes_are_ignored():
    assert conversation_sids([alert(code=50361), alert(code=None)]) == []


def test_one_chatty_conversation_is_one_finding():
    assert conversation_sids([alert(), alert(), alert(resource=CH2)]) == [CH, CH2]


def test_the_conversation_sid_is_recovered_from_the_alert_text():
    a = alert(resource="ACxxxxxxxx", text="Conversation webhook URL not provided "
                                          "for %s" % CH2)
    assert conversation_sids([a]) == [CH2]


def test_a_webhook_target_with_no_url_is_the_finding():
    state, detail = verdict(hook("webhook", url=None))
    assert state == "missing-url"
    assert "50369" in detail


def test_a_studio_target_with_no_url_is_correct():
    # This is the false positive that would make the report useless: a studio
    # webhook routes to a Flow and never has a URL.
    state, detail = verdict(hook("studio", flow_sid="FW1"))
    assert state == "studio"
    assert "FW1" in detail


def test_a_studio_target_with_no_flow_is_still_wrong():
    assert verdict(hook("studio"))[0] == "studio-no-flow"


def test_a_trigger_target_needs_a_url_too():
    assert verdict(hook("trigger", url=""))[0] == "missing-url"
    assert verdict(hook("trigger", url="https://app.example.com/hook"))[0] == "ok"


def test_plain_http_is_reported_separately_from_the_missing_url():
    state, detail = verdict(hook("webhook", url="http://app.example.com/hook"))
    assert state == "insecure"
    assert "Not 50369" in detail
