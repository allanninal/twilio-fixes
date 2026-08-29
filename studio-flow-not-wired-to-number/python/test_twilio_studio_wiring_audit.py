from twilio_studio_wiring_audit import attachments, verdict

FLOW = "FW11111111111111111111111111111111"
HOOK = "https://webhooks.twilio.com/v1/Accounts/ACxxx/Flows/" + FLOW


def number(phone="+15550001111", **fields):
    row = {"sid": "PN1", "phone_number": phone, "voice_url": "", "sms_url": "",
           "voice_application_sid": ""}
    row.update(fields)
    return row


def test_a_number_whose_sms_url_is_the_studio_webhook_counts():
    attach = attachments(FLOW, [number(sms_url=HOOK)])
    assert attach["sms"] == ["+15550001111"]
    assert attach["voice"] == []


def test_a_query_string_on_the_webhook_still_matches():
    # Matched as a substring on purpose: an equality test against a rebuilt URL
    # reports every Flow on the account as unwired.
    attach = attachments(FLOW, [number(voice_url=HOOK + "?lang=fr")])
    assert attach["voice"] == ["+15550001111"]


def test_a_different_flow_sid_does_not_match():
    other = "FW22222222222222222222222222222222"
    assert attachments(other, [number(sms_url=HOOK)]) == {
        "voice": [], "sms": [], "via_application": []}


def test_numbers_on_an_application_sid_are_recorded_as_unanswerable():
    attach = attachments(FLOW, [number(voice_application_sid="AP1")])
    assert attach["via_application"] == ["+15550001111"]
    assert attach["voice"] == []


def test_a_wired_flow_with_traffic_is_healthy():
    state, detail = verdict({"status": "published"},
                            {"voice": [], "sms": ["+15550001111"],
                             "via_application": []}, 12)
    assert state == "wired"
    assert "12 execution(s)" in detail


def test_executions_with_no_number_is_not_an_orphan():
    state, detail = verdict({"status": "published"}, None, 40)
    assert state == "triggered-elsewhere"
    assert "REST Executions API" in detail


def test_no_number_and_no_executions_is_the_finding():
    state, detail = verdict({"status": "published"},
                            {"voice": [], "sms": [], "via_application": ["+15550002222"]},
                            0)
    assert state == "orphan"
    assert "voice_application_sid" in detail


def test_a_draft_flow_is_a_different_problem():
    state, detail = verdict({"status": "draft"}, None, 0)
    assert state == "unpublished"
    assert "Publish first" in detail
