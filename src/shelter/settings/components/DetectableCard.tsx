import type { Game } from "arrpc";
import { setRestartRequired } from "../settings.js";
import classes from "./DetectableCard.module.css";

const {
    ui: { Header, HeaderTags, openConfirmationModal },
    plugin: { store },
} = shelter;

export const DetectableCard = (props: { detectable: Game; onRemove: () => void }) => {
    function removeDetectable() {
        openConfirmationModal({
            header: () => store.i18n["games-removeConfirmHeader"],
            body: () => store.i18n["games-removeConfirmBody"],
            type: "danger",
            confirmText: store.i18n["games-remove"],
            cancelText: store.i18n["settings-restartLater"],
        }).then(
            () => {
                window.legcord.rpc.removeDetectable(props.detectable.id);
                setRestartRequired();
                props.onRemove();
            },
            () => {},
        );
    }

    const executablesLabel =
        props.detectable.executables.map((e) => e.name).join(", ") || store.i18n["games-noExecutables"];

    return (
        <div class={classes.card}>
            <div class={classes.info}>
                <div class={classes.mainInfo}>
                    <Header tag={HeaderTags.H2} class={classes.title}>
                        {props.detectable.name}
                    </Header>
                    <Header class={classes.eyebrow} tag={HeaderTags.EYEBROW}>
                        {props.detectable.id}
                    </Header>
                </div>
                <Header tag={HeaderTags.H5}>{executablesLabel}</Header>
            </div>
            <button title={store.i18n["games-remove"]} type="button" onClick={removeDetectable} class={classes.btn}>
                <img class={classes.icon} alt={store.i18n["games-remove"]} src="legcord://assets/Trash.png" />
            </button>
        </div>
    );
};
