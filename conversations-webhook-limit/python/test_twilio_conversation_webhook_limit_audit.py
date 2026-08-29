from twilio_conversation_webhook_limit_audit import (
    destination, verdict, webhook_total)

URL = "https://app.example.com/hook"


def hook(sid, url=URL, target="webhook", method="POST", flow=None):
    cfg = {"url": url, "method": method}
    if flow:
        cfg = {"flow_sid": flow}
    return {"sid": sid, "target": target, "configuration": cfg}


def distinct(n):
    return [hook("WH%d" % i, "%s/%d" % (URL, i)) for i in range(n)]


def test_five_distinct_webhooks_is_the_ceiling():
    state, detail = verdict(5, distinct(5))
    assert state == "at-limit"
    assert "50361" in detail


def test_a_duplicate_at_the_ceiling_is_a_free_slot():
    hooks = distinct(4) + [hook("WH9", "%s/0" % URL)]
    state, detail = verdict(5, hooks)
    assert state == "at-limit-duplicates"
    assert "frees a slot" in detail


def test_a_duplicate_below_the_ceiling_is_still_a_finding():
    state, detail = verdict(2, [hook("WH1"), hook("WH2")])
    assert state == "duplicates"
    assert "twice for every event" in detail


def test_four_distinct_webhooks_is_one_slot_from_failing():
    assert verdict(4, distinct(4))[0] == "near-limit"


def test_an_empty_conversation_is_not_a_finding():
    assert verdict(0, [])[0] == "none"
    assert verdict(2, distinct(2))[0] == "headroom"


def test_destination_ignores_case_and_a_trailing_slash():
    assert destination(hook("WH1", "https://App.Example.com/hook/")) == \
        destination(hook("WH2", URL))


def test_a_studio_target_is_keyed_on_the_flow():
    assert destination(hook("WH1", target="studio", flow="FW1")) == "studio FW1"
    assert destination(hook("WH1", target="studio", flow="FW1")) != \
        destination(hook("WH2", target="studio", flow="FW2"))


def test_meta_total_wins_over_the_length_of_the_page():
    # A smaller PageSize returns fewer entries than the conversation holds, and
    # counting the array would report headroom on a conversation at the cap.
    page = {"webhooks": distinct(2), "meta": {"total": 5}}
    assert webhook_total(page) == 5
    assert webhook_total({"webhooks": distinct(2), "meta": {}}) == 2
