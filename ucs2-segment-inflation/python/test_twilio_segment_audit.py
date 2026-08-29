from twilio_segment_audit import (offenders, segments, sms_encoding, tally,
                                  transliterate, verdict)

CURLY = "’"     # right single quotation mark, the usual culprit
PARTY = "🎉"  # an emoji, outside the Basic Multilingual Plane


def test_plain_ascii_is_gsm7():
    assert sms_encoding("Your code is 123456") == "GSM-7"


def test_one_curly_apostrophe_moves_the_whole_body_to_ucs2():
    assert sms_encoding("It%ss ready" % CURLY) == "UCS-2"


def test_gsm7_segment_boundary_is_160_then_153():
    assert segments("a" * 160) == ("GSM-7", 160, 1)
    assert segments("a" * 161)[2] == 2
    assert segments("a" * 306)[2] == 2
    assert segments("a" * 307)[2] == 3


def test_extension_characters_cost_two_units():
    # 80 euro signs is 160 units: still one segment, but at half the characters.
    assert segments("€" * 80) == ("GSM-7", 160, 1)
    assert segments("€" * 81)[2] == 2


def test_ucs2_segment_boundary_is_70_then_67():
    body = "а" * 70  # Cyrillic
    assert segments(body) == ("UCS-2", 70, 1)
    assert segments("а" * 71)[2] == 2


def test_an_emoji_costs_two_utf16_units():
    encoding, units, count = segments(PARTY * 40)
    assert encoding == "UCS-2"
    assert units == 80
    assert count == 2


def test_one_smart_quote_turns_one_segment_into_three():
    body = "a" * 149 + CURLY
    state, detail = verdict(body)
    assert state == "ucs2-avoidable"
    assert segments(body)[2] == 3
    assert segments(transliterate(body))[2] == 1
    assert "2 extra segment(s)" in detail


def test_an_emoji_is_ucs2_that_nothing_can_fix():
    state, detail = verdict("Sale today " + PARTY)
    assert state == "ucs2-required"
    assert "cannot be transliterated" in detail


def test_billing_fewer_segments_means_smart_encoding_already_ran():
    state, detail = verdict("a" * 149 + CURLY, reported=1)
    assert state == "smart-encoded"
    assert "still wrong" in detail


def test_offenders_are_deduplicated_and_carry_their_substitute():
    found = offenders("%s%s ok %s" % (CURLY, CURLY, PARTY))
    assert [c for c, _ in found] == [CURLY, PARTY]
    assert found[0][1] == chr(39)
    assert found[1][1] is None


def test_tally_adds_up_the_avoidable_segments_per_sender():
    body = "a" * 149 + CURLY
    rows = tally([
        {"sid": "SM1", "messaging_service_sid": "MG1", "body": body},
        {"sid": "SM2", "messaging_service_sid": "MG1", "body": body},
        {"sid": "SM3", "messaging_service_sid": "MG1", "body": "plain text"},
        {"sid": "SM4", "from": "+15550001111", "direction": "inbound", "body": body},
    ])
    assert list(rows) == ["MG1"]
    assert rows["MG1"] == {"total": 3, "ucs2": 2, "extra": 4,
                           "chars": [CURLY], "sids": ["SM1", "SM2"]}
