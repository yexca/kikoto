import { Gauge, ListMusic, Moon, SkipBack, SkipForward } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function NowPlayingPage() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <Card>
        <CardContent className="p-4">
          <div className="grid aspect-square place-items-center rounded-lg bg-primary text-4xl font-bold text-primary-foreground">
            RJ
          </div>
          <h2 className="mt-4 text-lg font-semibold">Current track title</h2>
          <p className="text-sm text-muted-foreground">Sample work stub</p>
          <div className="mt-4 h-2 rounded-full bg-muted">
            <div className="h-2 w-1/3 rounded-full bg-primary" />
          </div>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="outline" size="icon" aria-label="Previous">
              <SkipBack className="h-4 w-4" />
            </Button>
            <Button aria-label="Play">Play</Button>
            <Button variant="outline" size="icon" aria-label="Next">
              <SkipForward className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-1">
        {[
          { icon: Gauge, title: "Playback speed", value: "1.0x" },
          { icon: Moon, title: "Sleep timer", value: "Off" },
          { icon: ListMusic, title: "Queue", value: "3 pending tracks" },
        ].map((item) => (
          <Card key={item.title}>
            <CardContent className="flex min-h-24 items-center gap-3 p-4">
              <item.icon className="h-5 w-5 text-primary" />
              <div>
                <div className="text-sm font-medium">{item.title}</div>
                <div className="text-sm text-muted-foreground">{item.value}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
