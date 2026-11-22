# Vision

My Own Data Center is the application you use to watch and run a data center you own. One sign-in reaches the physical machines, the virtual machines, the container applications, the storage, the backups, and the files. The same product is in your hand on a phone and on the desk in a browser.

The short name in the interface is MODC. A sentence that needs the product name says My Own Data Center. The command remains `omarchy-server`. Certificates, the backup folder, and system markers keep the names already installed on a machine.

## Who it is for

A person who runs their own hardware. This server is the place they sign in. Other computers join it and stand as peers. They manage it from a phone, a tablet, or a desktop, including when they are not sitting at the machine.

The owner manages the server. Someone else who signs in sees the machines and actions they were allowed.

## What it covers

These are one product. A new capability is a screen the person already understands, aimed at the machine it belongs to.

### The fleet

Home shows whether the data center is healthy. CPU, memory, storage, GPU, temperature, and laptop battery are aggregates across the computers that are online. A warning or a danger is visible on the gauge and opens the machines behind it. A reading the software does not have is shown as missing.

### Physical machines

Every physical computer is the same kind of thing: this server, a computer that joined through the connector, and the next one you add. Each has a name, a state, and the same page. Grouping may show which machine hosts guests. The page itself does not change its shape because of that grouping.

### Virtual machines

A virtual machine is a machine that runs on a host. Its page matches a physical machine. The host adds only what the hypervisor really provides: power, the guest's screen, USB devices, port forwards, snapshots, cloud-init, and disk backups. A virtual machine does not host further virtual machines.

Two states are part of the product:

- Without a connector, the host can power the guest and open its screen while it is running. Gauges use the host's measurements. The guest's files and shell are not invented.
- With a connector, the guest is managed like a joined computer, plus the host controls above. The connector is the same Linux connector a physical computer uses, tied to that virtual machine. It runs on Linux with systemd. Windows, macOS, and Home Assistant do not run it.

### Applications

An application is a container on one machine. It is installed, started, stopped, and opened there. It has a name, a state, and an address when it serves one. It is not a computer: it has no drives of its own, no connector, and no row in the machine list. Its data and its updates belong to that container. The catalog asks which machine receives an install. A virtual machine can take an application after its connector is installed.

### Storage

Disks, pools, removable media, and drive sleep belong to the machine that holds them. Usage is that machine's storage, in real units. A virtual machine's image size on the host is the host's disk, not a fake reading of the guest's free space.

### Backups

Backups belong to the machine they protect. This server can keep the copies. Restoring is an action on that machine. Folder backups from a computer and disk backups of a virtual machine are different jobs and stay named as what they are.

### Files

There is one file manager. It lists this server and the other machines that can be browsed, and it is how you open, move, and copy files and folders. A file shows which machine it came from. Recent files and favorites are part of every file list.

### The screen and the shell

Every machine that can show a desktop offers Open desktop, and that includes a virtual machine's screen. Every machine that can offer a shell offers Terminal, with the same controls. The terminal is the shell. The desktop is the screen.

### Power

Start, stop, restart, pause, hibernate, and shut down live on the machine they affect. Shutting down this server is a server action. Powering a virtual machine is a host action.

### Access

A joined computer or a guest exposes only the capabilities granted when it was paired: files, terminal, desktop, storage, backups, and management. Granting more is a pairing decision on that machine.

### Networking and attached devices

Addresses, shared folders, port forwards, and USB devices passed to a virtual machine are managed with that machine.

### History

Snapshots, changes, and the record of what happened open from the machine they describe.

### Accounts and this application

Sign-in, devices, appearance, and updating My Own Data Center belong to the product. They are not a substitute for a machine's own disks, backups, or gauges.

### Alerts

When a measure crosses a warning or a danger, Home shows it. Opening it names the machines. The interface does not hide a full disk, a hot CPU, or a low battery behind a separate tool.

## Where it is going

The following belong in this same application, using the same machine pages and the same fleet view. They are the direction, and they are not a second product.

- Vulnerability management: what is exposed, on which machine, and which container.
- Security scanning: a check the person runs against a machine or an image.
- Intrusion detection: unexpected activity tied to the machine where it happened.
- Patch and update status for machines and containers, read next to those findings.
- A record of who approved a change that affected a machine.

Until those exist, the product still tells the truth about health, access, and what each machine can do. A screen does not pretend a scan has been run.

## What stays true

- The person runs this on hardware they control. The browser is the client.
- Phone and desktop are two layouts of one product. Ubuntu windows and Hyprland tiles are two shells of the desktop layout.
- Sign-in, TLS, and the grants on a connector stay in force. A clearer screen does not drop them.
- Numbers, file lists, and permissions come from the machine. The interface does not fill a gap with a made-up value.

## What this is not

A replacement operating system. A different application for virtual machines than for computers. A container treated as a computer. A dashboard that invents readings so a gauge looks full.
