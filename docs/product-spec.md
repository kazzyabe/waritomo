# Product Spec

## Working Name

ワリトモ

## Problem

Small travel groups often pay for one another throughout a trip. The hard part is
not a single split calculation; it is keeping a shared, trusted ledger where
everyone can add expenses, confirm their identity, and settle without leaving
LINE.

## Core Users

- Trip organizer: creates the group and invites friends.
- Participant: claims their member slot, adds expenses, checks what they owe.
- Settler: uses the final settlement list and marks transfers as done.

## MVP User Flows

### Create Group

1. User opens the mini app.
2. User enters group name, base currency, rounding unit, and member names.
3. App creates the group and redirects to the invite screen.
4. User shares the permanent link through LINE.

### Join Group

1. User opens an invite permanent link.
2. App verifies LINE session.
3. User selects "I am this member" or adds themselves if allowed.
4. App links `line_user_id` to `group_member`.
5. User lands on the group ledger.

### Add Expense

1. User taps add expense.
2. User selects payer, item name, currency, amount, and participants.
3. User chooses equal split or per-member amounts.
4. App saves the expense and recalculates the settlement.

### Share Settlement

1. User opens the settlement tab.
2. App displays the minimized payback list.
3. User sends a LINE share message with summary and permanent link.

### Confirm Settlement

1. Any group member marks a payback item as paid once the transfer is done.
2. The mark is shared with the whole group, and anyone can undo it.
3. Marked items stay in the settlement list so the group can see what is left.

### Manage Group

1. Organizer can rename a group after creation.
2. Organizer can mark a group complete so the settled ledger stays in the
   history list.
3. Organizer can delete a group when it is no longer needed.

## MVP Screens

- Home / my groups
- Create group
- Invite group
- Join / claim member
- Group ledger
- Expense editor
- Settlement
- Member settings
- Group settings
- Error / expired invite

## Non-MVP

- In-app payments or bank transfer execution.
- Automatic LINE room detection.
- Receipt OCR.
- Native app.
- Ads.
- Service messages beyond tested, policy-safe confirmations.

## Product Decisions

- The app has no password account system. LINE identity is the primary identity.
- A group member can exist before a LINE user claims it.
- Marking a payback as paid is one-sided. Requiring the receiver to confirm
  would leave the ledger stuck whenever they never open the app.
- Expense edits are collaborative by default in MVP. There is no audit log:
  the ledger is the shared record, and a changed amount shows up in a total
  the whole group can see.
- Base currency settlement is required; multi-currency expenses use a stored rate snapshot.
- The product should work even if target picker is unavailable, via copyable permanent links.
