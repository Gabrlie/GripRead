# Decision: Online books read as one resource per chapter

Status: implemented

## Problem

The reader and its locators were built for one TXT resource whose length is known before reading: the controller joins bounded windows by offset, and positions, chapter ranges, and progress are offsets in that text. An online book's chapters arrive one at a time from a source, their lengths are unknown until fetched, and replace rules or 简繁 change their text after they are kept.

## Decision

Each chapter of an online book is its own reader resource, `chapter-<n>`, as Legado's ReadBook treats chapters. Its text is the title line followed by the source's content, read whole from the device cache or the source and then transformed, so no TXT index is needed. A locator stays `{bookId, contentVersion, resourceId, offset, context}`; the content version derives from the chapter's address and title, so a changed transform only shifts offsets slightly and a position clamps instead of failing. Content windows carry the neighbouring resource ids and the chapter's position and count. The controller keeps only one resource's windows at a time and, at a resource edge in page modes, reads the neighbouring resource from its start or up to its end. Scroll mode shows the neighbouring chapters above and below the current one and moves into them as the view's top passes their edge. Chapter texts are kept as the source gave them; replace rules and 简繁 apply when read.

## Alternatives considered

A virtual single resource concatenating all chapters would keep the controller unchanged, but its offsets would move whenever a chapter is fetched or re-fetched, invalidating every later position. Fixed-size offset slots per chapter would keep offsets stable but break the contiguous-window contract the controller validates. Joining chapters into one continuous scroll with a second offset space was set aside; the scroll view instead keeps each chapter in its own box with its own offsets.

## Consequences

Local TXT reading is unchanged. Online positions and bookmarks are per chapter, and moving between chapters reads the neighbouring resource, which may wait for the network when the chapter is not cached; chapters ahead are fetched in the background and the neighbours are read ahead near an edge.
