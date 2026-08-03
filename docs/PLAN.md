# WebRTC P2P App Plan

## Goal

Build a simple browser-to-browser communication app using **Next.js** and **WebRTC**.

### Requirements

- No authentication
- No database
- Hosted on Vercel
- Direct browser-to-browser communication
- Shareable room link
- Simple and lightweight architecture

---

# Architecture

```text
Browser A
    │
    │ Join Room
    ▼
Signaling Server
    ▲
    │
Browser B

After WebRTC negotiation

Browser A ◄──────────────► Browser B
         DataChannel
```

The signaling server is **only used during connection setup**. After the connection is established, all data is transferred directly between browsers.

---

# Project Structure

```
app/
│
├── page.tsx               # Home page
├── room/
│   └── [id]/
│       └── page.tsx       # Room page
│
components/
│   ├── Chat.tsx
│   ├── PeerConnection.tsx
│   └── RoomControls.tsx
│
lib/
│   ├── webrtc.ts
│   ├── signaling.ts
│   └── utils.ts
```

---

# Phase 1 - Project Setup

- Create Next.js project
- Configure TypeScript
- Deploy to Vercel
- Create Home page
- Create Room page

Deliverable:

- User can create or join a room.

---

# Phase 2 - Room System

Generate a random room ID.

Example:

```
https://your-app.vercel.app/room/8GkQ9L
```

Features:

- Create Room button
- Join Room input
- Copy room link

Deliverable:

- Two browsers can open the same room.

---

# Phase 3 - Signaling Server

Purpose:

Exchange WebRTC information only.

Messages:

- Join Room
- Offer
- Answer
- ICE Candidate
- Leave Room

No authentication.

No database.

No persistent storage.

Deliverable:

- Browsers can exchange signaling messages.

---

# Phase 4 - WebRTC Connection

Create:

- RTCPeerConnection
- RTCDataChannel

Flow:

```
Browser A
    │
Create Offer
    │
Signaling
    │
Browser B
    │
Create Answer
    │
Signaling
    │
Connection Established
```

Deliverable:

- Peer-to-peer connection established.

---

# Phase 5 - Messaging

Use the DataChannel.

Features:

- Send message
- Receive message
- Connection status
- Disconnect handling

Deliverable:

- Real-time chat.

---

# Phase 6 - Polish

Improve UX.

Features:

- Copy room link
- Auto reconnect (optional)
- Typing indicator (optional)
- Connection status badge
- Error messages

---

# Future Features

- File transfer
- Voice chat
- Video chat
- Screen sharing
- Clipboard sync
- Multiplayer game support
- Collaborative whiteboard
- Presence indicators

---

# Tech Stack

Frontend

- Next.js
- React
- TypeScript
- Tailwind CSS

Communication

- WebRTC
- RTCDataChannel

Hosting

- Vercel

Signaling

- Lightweight WebSocket server

---

# Development Checklist

## Setup

- [ ] Create Next.js app
- [ ] Configure Tailwind
- [ ] Deploy to Vercel

## Rooms

- [ ] Generate room IDs
- [ ] Join existing room
- [ ] Copy invite link

## Signaling

- [ ] WebSocket connection
- [ ] Join room
- [ ] Send offer
- [ ] Receive offer
- [ ] Send answer
- [ ] Receive answer
- [ ] Exchange ICE candidates

## WebRTC

- [ ] Create peer connection
- [ ] Create data channel
- [ ] Open connection
- [ ] Handle disconnects

## Chat

- [ ] Send messages
- [ ] Receive messages
- [ ] Display timestamps
- [ ] Show connection status

## Testing

- [ ] Same browser (two tabs)
- [ ] Two different browsers
- [ ] Two different devices
- [ ] Different networks

---

# Success Criteria

- No user accounts
- No database
- Shareable room links
- Direct peer-to-peer communication
- Hosted on Vercel
- Fast connection setup
- Clean and minimal codebase

---

# Phase 6 - File Transfer

Transfer files directly between connected peers using the WebRTC DataChannel.

## Features

- Send any file type
- Receive files
- Drag & Drop support
- Multiple file selection
- Transfer progress
- Cancel transfer
- Image preview
- Download received files

## Transfer Flow

```text
User A
Select File
    │
Read File
    │
Split into Chunks
    │
WebRTC DataChannel
    │
Receive Chunks
    │
Rebuild File
    │
Download
User B
```

## Implementation

### Sender

- Select file using the File API
- Read file as an ArrayBuffer
- Split into fixed-size chunks (16–64 KB)
- Send metadata first:
  - File name
  - File size
  - MIME type
- Send each chunk
- Send completion message

### Receiver

- Receive metadata
- Store incoming chunks
- Track progress
- Reassemble chunks into a Blob
- Create download link
- Allow preview for supported file types

Deliverable:

- Peer-to-peer file transfer working for files of various sizes.

---

# Future Enhancements

## Messaging

- Message history (current session)
- Typing indicator
- Read receipts
- Emoji support

## File Sharing

- Folder transfer
- Pause/Resume
- Resume interrupted transfers
- Parallel chunk uploads
- Drag & Drop
- Clipboard paste support
- Thumbnail previews
- File integrity verification (checksum)

## Collaboration

- Clipboard sync
- Whiteboard
- Notes sharing
- Cursor sharing

## Media

- Voice calls
- Video calls
- Screen sharing

---

# Updated Development Checklist

## Chat

- [ ] Send messages
- [ ] Receive messages
- [ ] Display timestamps

## File Transfer

- [ ] Select file
- [ ] Drag & Drop
- [ ] Send metadata
- [ ] Send chunks
- [ ] Receive chunks
- [ ] Reassemble file
- [ ] Download file
- [ ] Preview images
- [ ] Show progress
- [ ] Cancel transfer

## WebRTC

- [ ] Peer connection
- [ ] DataChannel
- [ ] ICE candidate exchange
- [ ] Connection status
- [ ] Reconnect handling