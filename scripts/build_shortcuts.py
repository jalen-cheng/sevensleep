#!/usr/bin/env python3
"""Builds the ready-made iPhone Shortcuts in docs/shortcuts.

Writes one unsigned file per Shortcut into a folder. An iPhone only imports signed ones, so
sign each on a Mac, into docs/shortcuts under the Shortcut's own name:

    python3 scripts/build_shortcuts.py unsigned/
    shortcuts sign --mode anyone --input "unsigned/Bed off.shortcut" --output "docs/shortcuts/Bed off.shortcut"

Two of them do what the app cannot: "Send sleep to SevenSleep" reads Apple Health (one run
sends the last two weeks, so it is tapped now and then at home, not every day), and "Open SevenSleep"
opens the app from anywhere, connecting Tailscale first when away from home. The other four
are optional, for Siri and automations: they talk to the Pod at its home address.

Every Shortcut begins with Text actions holding what differs from one home to the next (the
Pod's address, the home Wi-Fi's name). They are asked for when the Shortcut is added, so nobody
has to edit an action. Every action is written the way the Shortcuts editor writes it, taken
from exported shortcuts: a wrong key or label makes an action import with an empty setting.
The one exception is Tailscale's Connect, written from Tailscale's published list of actions.
"""

from pathlib import Path
import plistlib
import sys
import uuid

HOME_ADDRESS = 'http://sevensleep.local'
TAILSCALE_ADDRESS = 'http://sevensleep:3000'
ADDRESS_OUTPUT_NAME = 'Pod address'
AWAY_ADDRESS_OUTPUT_NAME = 'Pod address away'
WIFI_OUTPUT_NAME = 'Home Wi-Fi'
HOME_ADDRESS_QUESTION = "Your Pod's address at home, as you open the app there"
TAILSCALE_ADDRESS_QUESTION = "Your Pod's address over Tailscale: its Tailscale name, then :3000"
WIFI_QUESTION = "Your home Wi-Fi's name, exactly as the phone shows it"
SLEEP_SOURCE_NAME = 'Apple Health'
# Two days, so a run late in the day still reaches back over last night. Sending a night twice
# changes nothing on the Pod.
# Two weeks in one run: enough to fit the sleep rules from one tap, and to catch up after days away
SLEEP_DAYS_LOOKED_BACK = 14
# Tailscale takes a moment to be usable after it connects
SECONDS_FOR_TAILSCALE = 2

# The marker the editor puts in a text where a variable goes
VARIABLE_MARK = '￼'
# The editor's codes: "is" (for a filter and for an If), "is in the last", days, the kinds of
# value a JSON field can hold, and the parts of a repeat or an If
OPERATOR_IS = 4
OPERATOR_IN_THE_LAST = 1001
UNIT_DAYS = 16
ITEM_TYPE_TEXT = 0
ITEM_TYPE_DICTIONARY = 1
ITEM_TYPE_NUMBER = 3
ITEM_TYPE_BOOLEAN = 4
CONTROL_FLOW_START = 0
CONTROL_FLOW_MIDDLE = 1
CONTROL_FLOW_END = 2


def new_uuid():
    return str(uuid.uuid4()).upper()


def action(name, parameters):
    return {'WFWorkflowActionIdentifier': f'is.workflow.actions.{name}', 'WFWorkflowActionParameters': parameters}


def output_of(output_uuid, output_name):
    """A reference to what an earlier action produced."""
    return {'OutputUUID': output_uuid, 'Type': 'ActionOutput', 'OutputName': output_name}


def variable_input(variable):
    """A whole setting filled by one variable."""
    return {'Value': variable, 'WFSerializationType': 'WFTextTokenAttachment'}


def text_with(parts):
    """A text setting made of plain strings and variables (dicts), in order."""
    string = ''
    attachments = {}
    for part in parts:
        if isinstance(part, str):
            string += part
        else:
            attachments[f'{{{len(string)}, 1}}'] = part
            string += VARIABLE_MARK
    value = {'string': string}
    if attachments:
        value['attachmentsByRange'] = attachments
    return {'Value': value, 'WFSerializationType': 'WFTextTokenString'}


def fields(items):
    """The fields of a JSON body, or of a dictionary inside one."""
    return {'Value': {'WFDictionaryFieldValueItems': items}, 'WFSerializationType': 'WFDictionaryFieldValue'}


def text_field(key, value_parts):
    return {'WFKey': text_with([key]), 'WFItemType': ITEM_TYPE_TEXT, 'WFValue': text_with(value_parts)}


def number_field(key, value_parts):
    return {'WFKey': text_with([key]), 'WFItemType': ITEM_TYPE_NUMBER, 'WFValue': text_with(value_parts)}


def boolean_field(key, is_true):
    return {
        'WFKey': text_with([key]), 'WFItemType': ITEM_TYPE_BOOLEAN,
        'WFValue': {'Value': is_true, 'WFSerializationType': 'WFNumberSubstitutableState'},
    }


def dictionary_field(key, items):
    return {'WFKey': text_with([key]), 'WFItemType': ITEM_TYPE_DICTIONARY, 'WFValue': fields(items)}


def both_sides(key, is_true):
    """A JSON body that sets one switch the same on the left and the right."""
    return [dictionary_field(side, [boolean_field(key, is_true)]) for side in ('left', 'right')]


def asked_text(output_name, default, text_uuid):
    """A Text action whose content is asked for when the Shortcut is added."""
    return action('gettext', {'WFTextActionText': default, 'UUID': text_uuid, 'CustomOutputName': output_name})


def request(address_uuid, path, response_uuid, json_items=None, address_name=ADDRESS_OUTPUT_NAME):
    """Get Contents of URL on the Pod: a GET, or a POST with a JSON body when fields are given."""
    parameters = {'WFURL': text_with([output_of(address_uuid, address_name), path]), 'UUID': response_uuid}
    if json_items is not None:
        parameters.update({'WFHTTPMethod': 'POST', 'WFHTTPBodyType': 'JSON', 'WFJSONValues': fields(json_items)})
    return action('downloadurl', parameters)


def answer_value(response_uuid, key, value_uuid):
    """Get Dictionary Value: one field of the Pod's answer."""
    return action('getvalueforkey', {
        'WFInput': variable_input(output_of(response_uuid, 'Contents of URL')), 'WFDictionaryKey': key, 'UUID': value_uuid,
    })


def notification(body_parts):
    return action('notification', {
        'WFNotificationActionTitle': 'SevenSleep', 'WFNotificationActionBody': text_with(body_parts), 'UUID': new_uuid(),
    })


def network_name(network_uuid):
    """Get Network Details as the editor leaves it: the name of the Wi-Fi the phone is on."""
    return action('getwifi', {'UUID': network_uuid})


def if_on_wifi(network_uuid, wifi_uuid, group):
    """If the Wi-Fi the phone is on is the home Wi-Fi asked for when the Shortcut was added."""
    return action('conditional', {
        'WFInput': {'Type': 'Variable', 'Variable': variable_input(output_of(network_uuid, 'Network Details'))},
        'WFCondition': OPERATOR_IS,
        'WFConditionalActionString': text_with([output_of(wifi_uuid, WIFI_OUTPUT_NAME)]),
        'GroupingIdentifier': group,
        'WFControlFlowMode': CONTROL_FLOW_START,
    })


def otherwise(group):
    return action('conditional', {'GroupingIdentifier': group, 'WFControlFlowMode': CONTROL_FLOW_MIDDLE})


def end_if(group):
    return action('conditional', {'GroupingIdentifier': group, 'WFControlFlowMode': CONTROL_FLOW_END, 'UUID': new_uuid()})


def tailscale_connect():
    """Tailscale's own Connect action, then a moment for the connection to be usable. Connecting
    when already connected changes nothing. Not taken from an export: see the note at the top."""
    connect = {
        'WFWorkflowActionIdentifier': 'io.tailscale.ipn.ios.ConnectIntent',
        'WFWorkflowActionParameters': {
            'AppIntentDescriptor': {
                'AppIntentIdentifier': 'ConnectIntent', 'BundleIdentifier': 'io.tailscale.ipn.ios',
                'Name': 'Tailscale', 'TeamIdentifier': 'W5364U7YZB',
            },
            'UUID': new_uuid(),
        },
    }
    return [connect, action('delay', {'WFDelayTime': SECONDS_FOR_TAILSCALE})]


def sample_detail(property_name, detail_uuid):
    """Get Details of Health Sample: one property of the sample the repeat is on."""
    return action('properties.health.quantity', {
        'WFInput': variable_input({'VariableName': 'Repeat Item', 'Type': 'Variable'}),
        'UUID': detail_uuid,
        'WFContentItemPropertyName': property_name,
    })


def iso_date(detail_uuid, property_name, formatted_uuid):
    """Format Date: a sample's date as ISO 8601 with its time and zone."""
    return action('format.date', {
        'WFDateFormatStyle': 'ISO 8601',
        'WFISO8601IncludeTime': True,
        'UUID': formatted_uuid,
        'WFDate': text_with([output_of(detail_uuid, property_name)]),
    })


def send_sleep_actions():
    """Finds the Sleep samples of the last two weeks, writes each as "start|end|value" with
    ISO 8601 times, posts the lines to the Pod and shows its answer as a notification. Away from
    home the Pod cannot be reached, and Shortcuts says so itself; nothing is lost, since the next
    run at home sends the same two weeks. Only the address is asked for when it is added."""
    address = new_uuid()
    samples, repeat_group, repeat_results = new_uuid(), new_uuid(), new_uuid()
    start, start_iso, end, end_iso, value, line = (new_uuid() for _ in range(6))
    response, message = new_uuid(), new_uuid()
    return [
        asked_text(ADDRESS_OUTPUT_NAME, HOME_ADDRESS, address),
        action('filter.health.quantity', {
            'WFContentItemFilter': {
                'Value': {
                    'WFActionParameterFilterPrefix': 1,
                    'WFContentPredicateBoundedDate': False,
                    'WFActionParameterFilterTemplates': [
                        {
                            'Property': 'Type', 'Operator': OPERATOR_IS, 'Removable': False, 'Bounded': True,
                            'Values': {'Enumeration': {'Value': 'Sleep', 'WFSerializationType': 'WFStringSubstitutableState'}},
                        },
                        {
                            'Property': 'Start Date', 'Operator': OPERATOR_IN_THE_LAST, 'Removable': False, 'Bounded': True,
                            'Values': {'Unit': UNIT_DAYS, 'Number': str(SLEEP_DAYS_LOOKED_BACK)},
                        },
                    ],
                },
                'WFSerializationType': 'WFContentPredicateTableTemplate',
            },
            'WFContentItemSortProperty': 'Start Date',
            'WFContentItemSortOrder': 'Oldest First',
            'WFContentItemLimitEnabled': False,
            'UUID': samples,
        }),
        action('repeat.each', {
            'WFInput': variable_input(output_of(samples, 'Health Samples')),
            'GroupingIdentifier': repeat_group,
            'WFControlFlowMode': CONTROL_FLOW_START,
        }),
        sample_detail('Start Date', start),
        iso_date(start, 'Start Date', start_iso),
        sample_detail('End Date', end),
        iso_date(end, 'End Date', end_iso),
        sample_detail('Value', value),
        action('gettext', {
            'WFTextActionText': text_with([
                output_of(start_iso, 'Formatted Date'), '|', output_of(end_iso, 'Formatted Date'), '|', output_of(value, 'Value'),
            ]),
            'UUID': line,
        }),
        action('repeat.each', {'UUID': repeat_results, 'GroupingIdentifier': repeat_group, 'WFControlFlowMode': CONTROL_FLOW_END}),
        request(address, '/api/autopilot/sleepTimes', response, [
            text_field('source', [SLEEP_SOURCE_NAME]),
            text_field('samples', [output_of(repeat_results, 'Repeat Results')]),
        ]),
        answer_value(response, 'message', message),
        notification([output_of(message, 'Dictionary Value')]),
    ]


def with_address(build_rest):
    """A Shortcut that begins with the Pod's address at home and then does what
    `build_rest(address_uuid)` returns."""
    address = new_uuid()
    return [asked_text(ADDRESS_OUTPUT_NAME, HOME_ADDRESS, address), *build_rest(address)]


def bed_temperature_actions():
    """Asks for a number from -10 to 10, turns the bed on and sets it."""
    asked = new_uuid()
    return with_address(lambda address: [
        action('ask', {
            'WFAskActionPrompt': 'Bed temperature, -10 to 10',
            'WFInputType': 'Number',
            'WFAskActionAllowsNegativeNumbers': True,
            'WFAskActionAllowsDecimalNumbers': True,
            'UUID': asked,
        }),
        request(address, '/api/deviceStatus/dial', new_uuid(), [number_field('dial', [output_of(asked, 'Provided Input')])]),
    ])


def bed_alarm_actions():
    """Asks for a time and sets a one-time alarm for the next time the clock shows it."""
    asked = new_uuid()
    return with_address(lambda address: [
        action('ask', {'WFAskActionPrompt': 'Alarm time', 'WFInputType': 'Time', 'UUID': asked}),
        request(address, '/api/alarm/time', new_uuid(), [text_field('time', [output_of(asked, 'Provided Input')])]),
    ])


def bed_status_actions():
    """Shows what the bed is set to and what it has reached, as a sentence."""
    response, summary = new_uuid(), new_uuid()
    return with_address(lambda address: [
        request(address, '/api/deviceStatus/dial', response),
        answer_value(response, 'summary', summary),
        action('showresult', {'Text': text_with([output_of(summary, 'Dictionary Value')])}),
    ])


def bed_off_actions():
    """Turns both sides off."""
    return with_address(lambda address: [
        request(address, '/api/deviceStatus', new_uuid(), both_sides('isOn', False)),
    ])


def open_app_actions():
    """Opens the app: straight away on the home Wi-Fi, and after connecting Tailscale anywhere else."""
    home, away, wifi, network, on_wifi = (new_uuid() for _ in range(5))
    return [
        asked_text(ADDRESS_OUTPUT_NAME, HOME_ADDRESS, home),
        asked_text(AWAY_ADDRESS_OUTPUT_NAME, TAILSCALE_ADDRESS, away),
        asked_text(WIFI_OUTPUT_NAME, '', wifi),
        network_name(network),
        if_on_wifi(network, wifi, on_wifi),
        action('openurl', {'WFInput': text_with([output_of(home, ADDRESS_OUTPUT_NAME)]), 'UUID': new_uuid()}),
        otherwise(on_wifi),
        *tailscale_connect(),
        action('openurl', {'WFInput': text_with([output_of(away, AWAY_ADDRESS_OUTPUT_NAME)]), 'UUID': new_uuid()}),
        end_if(on_wifi),
    ]


# Every Shortcut by the name it is added under
SHORTCUTS = {
    'Send sleep to SevenSleep': send_sleep_actions,
    'Open SevenSleep': open_app_actions,
    'Bed temperature': bed_temperature_actions,
    'Bed alarm': bed_alarm_actions,
    'Bed status': bed_status_actions,
    'Bed off': bed_off_actions,
}

# What is asked when a Shortcut is added, by the name of the Text action that holds the answer
QUESTIONS = {
    ADDRESS_OUTPUT_NAME: HOME_ADDRESS_QUESTION,
    AWAY_ADDRESS_OUTPUT_NAME: TAILSCALE_ADDRESS_QUESTION,
    WIFI_OUTPUT_NAME: WIFI_QUESTION,
}


def build_shortcut(name):
    actions = SHORTCUTS[name]()
    questions = []
    for index, built in enumerate(actions):
        parameters = built['WFWorkflowActionParameters']
        output_name = parameters.get('CustomOutputName')
        if output_name not in QUESTIONS:
            continue
        questions.append({
            'ActionIndex': index,
            'Category': 'Parameter',
            'DefaultValue': parameters['WFTextActionText'],
            'ParameterKey': 'WFTextActionText',
            'Text': QUESTIONS[output_name],
        })
    return {
        'WFWorkflowClientVersion': '4607',
        'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900',
        'WFWorkflowIcon': {'WFWorkflowIconStartColor': 463140863, 'WFWorkflowIconGlyphNumber': 61440},
        'WFWorkflowImportQuestions': questions,
        'WFWorkflowTypes': [],
        'WFWorkflowInputContentItemClasses': [],
        'WFWorkflowOutputContentItemClasses': [],
        'WFWorkflowHasShortcutInputVariables': False,
        'WFWorkflowHasOutputFallback': False,
        'WFQuickActionSurfaces': [],
        'WFWorkflowActions': actions,
    }


def main():
    if len(sys.argv) != 2:
        sys.exit('Usage: build_shortcuts.py <folder for the unsigned files>')
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    for name in SHORTCUTS:
        with open(folder / f'{name}.shortcut', 'wb') as output_file:
            plistlib.dump(build_shortcut(name), output_file, fmt=plistlib.FMT_BINARY)
        print(f'Wrote {folder / name}.shortcut')
    print('Sign each before sending it to a phone: shortcuts sign --mode anyone --input ... --output ...')


if __name__ == '__main__':
    main()
