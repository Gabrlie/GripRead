# Reading-state shelf groups

Status: implemented

## Problem

Schema 6 seeded seven genre groups that books joined by hand, and a book could be in several. The user asked for Legado-like default groups 全部, 在读, 未读, and 读完 that fill themselves from reading progress, while still letting the reader move any book by hand and keep that choice.

## Decision

Schema 11 deletes every existing group and membership, as the user chose, and keeps the tables for user-created groups. A book is shown in 全部 and in exactly one other group: its user group when it has one, otherwise a manual reading state stored in `books.shelf_state`, otherwise its automatic state. The automatic state is derived on the client from data the shelf already loads: unread without a saved position, finished once the position reaches the last chapter (or 99% of a book without chapters), reading otherwise. `move_book` sets one placement atomically (automatic, a state, or a group) and clears the others. Deleting a user group cascades its membership, so its books return to automatic grouping.

## Alternatives considered

Keeping the seeded groups that were still empty was offered; the user chose to delete all groups. Storing the automatic state in the database would need updates on every position save and on chapter rule changes; deriving it from the saved locator and the chapter listing keeps one authority. Allowing a book in several user groups was dropped because the user's rule is that a moved book stays where it was moved.

## Consequences

Existing group assignments are lost on upgrade by design. The shelf preference is reset to 全部 because its stored group no longer exists. Reading-state ids (`reading`, `unread`, `finished`) share the shelf preference with user group ids, which are UUIDs and cannot collide.
