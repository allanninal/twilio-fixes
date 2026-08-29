from twilio_conversations_filter_audit import split_filters, verdict

POST_URL = "https://app.example.com/conversations"


def config(**kw):
    base = {"post_webhook_url": POST_URL, "pre_webhook_url": "",
            "filters": ["onMessageAdded"], "method": "POST"}
    base.update(kw)
    return base


def test_a_good_url_with_no_filters_delivers_nothing():
    state, detail = verdict(config(filters=[]))
    assert state == "no-filters"
    assert "allowlist" in detail


def test_pre_action_names_against_a_post_url_deliver_nothing_either():
    state, detail = verdict(config(filters=["onMessageAdd", "onParticipantAdd"]))
    assert state == "post-url-no-post-filters"
    assert "-ed" in detail


def test_a_populated_list_missing_one_required_event_is_a_finding():
    state, detail = verdict(config(filters=["onParticipantAdded"]),
                            required=["onMessageAdded", "onParticipantAdded"])
    assert state == "missing-events"
    assert "onMessageAdded" in detail


def test_no_url_at_all_is_reported_before_the_filters():
    state, _ = verdict(config(post_webhook_url="", pre_webhook_url="", filters=[]))
    assert state == "no-webhook"


def test_a_pre_webhook_with_only_post_filters_is_its_own_finding():
    state, _ = verdict(config(post_webhook_url="", pre_webhook_url=POST_URL,
                              filters=["onMessageAdded"]))
    assert state == "pre-url-no-pre-filters"


def test_everything_the_application_asked_for_is_ok():
    state, _ = verdict(config(filters=["onMessageAdded", "onConversationStateUpdated"]),
                       required=["onMessageAdded", "onConversationStateUpdated"])
    assert state == "ok"


def test_split_filters_uses_the_tense_and_ignores_blanks():
    pre, post = split_filters(["onMessageAdd", "onMessageAdded", "", None,
                               "onConversationStateUpdated"])
    assert pre == ["onMessageAdd"]
    assert post == ["onMessageAdded", "onConversationStateUpdated"]
